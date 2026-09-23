import { describe, it, expect } from "vitest";
import { withTestDb, type TestDb } from "@/test/db";
import {
  importRows, checkSuppressed, findDuplicate, resolveImportCity, type ImportRow,
} from "./guardrails";
import { suppressions, listings, cities, categories } from "@/lib/db/schema";
import { makeVertical, makeCity, makeCategoryInCity } from "@/test/factories";
import { eq } from "drizzle-orm";
import { siteConfig } from "@/config/site.config";

const ADMIN = { role: "admin", userId: "importer" } as const;

const row: ImportRow = {
  name: "The Old Barn", city: "Leeds", category: "Barn Venues",
  addressLine1: "1 Farm Lane", postcode: "LS1 1AA", phone: "0113 496 0000",
  website: "https://oldbarn.example", sourceUrl: "https://register.example/123",
};

async function scaffold(tx: TestDb) {
  const verticalId = await makeVertical(tx);
  const cityId = await makeCity(tx, "Leeds", "West Yorkshire");
  await makeCategoryInCity(tx, verticalId, cityId, "Barn Venues");
}

describe("import guardrails", () => {
  it("sets source=scraped, unclaimed, and never verified or rated", async () => {
    await withTestDb(async (tx) => {
      await scaffold(tx);
      await importRows(tx, ADMIN, [row], { dryRun: false, mode: "scraped" });
      const [l] = await tx.select().from(listings);
      expect(l?.source).toBe("scraped");
      expect(l?.claimStatus).toBe("unclaimed");
      expect(l?.ratingAvg).toBeNull();
      expect(l?.ratingCount).toBe(0);
    });
  });

  it("records source_url and imported_at so a disputed row is traceable", async () => {
    await withTestDb(async (tx) => {
      await scaffold(tx);
      await importRows(tx, ADMIN, [row], { dryRun: false, mode: "scraped" });
      const [l] = await tx.select().from(listings);
      expect(l?.sourceUrl).toBe("https://register.example/123");
      expect(l?.importedAt).toBeInstanceOf(Date);
    });
  });

  it("rejects a description in scraped mode — facts only", async () => {
    await withTestDb(async (tx) => {
      await scaffold(tx);
      const r = await importRows(tx, ADMIN, [{ ...row, description: "A stunning converted..." }],
        { dryRun: false, mode: "scraped" });
      expect(r.rejected).toBe(1);
      expect(await tx.select().from(listings)).toHaveLength(0);
    });
  });

  it("keeps a description in authored mode and marks the source as import", async () => {
    await withTestDb(async (tx) => {
      await scaffold(tx);
      await importRows(tx, ADMIN, [{ ...row, description: "A restored barn. It sleeps 40." }],
        { dryRun: false, mode: "authored" });
      const [l] = await tx.select().from(listings);
      expect(l?.description).toBe("A restored barn. It sleeps 40.");
      expect(l?.source).toBe("import");
      expect(l?.shortDescription).toBe("A restored barn.");
    });
  });

  it("still refuses a verified state or a rating in authored mode", async () => {
    await withTestDb(async (tx) => {
      await scaffold(tx);
      await importRows(tx, ADMIN, [{ ...row, description: "Written copy." }], { dryRun: false, mode: "authored" });
      const [l] = await tx.select().from(listings);
      expect(l?.claimStatus).toBe("unclaimed");
      expect(l?.ratingAvg).toBeNull();
    });
  });

  it("refuses a row on the suppression list", async () => {
    await withTestDb(async (tx) => {
      await scaffold(tx);
      await tx.insert(suppressions).values({
        nameNormalised: "the old barn", postcodeNormalised: "ls11aa", reason: "removal request",
      });
      expect(await checkSuppressed(tx, ADMIN, row)).toBe(true);
      const r = await importRows(tx, ADMIN, [row], { dryRun: false, mode: "scraped" });
      expect(r.suppressed).toBe(1);
      expect(await tx.select().from(listings)).toHaveLength(0);
    });
  });

  it("cannot be defeated by retyping the postcode with different spacing or case", async () => {
    await withTestDb(async (tx) => {
      await scaffold(tx);
      await tx.insert(suppressions).values({
        nameNormalised: "the old barn", postcodeNormalised: "ls11aa", reason: "x",
      });
      expect(await checkSuppressed(tx, ADMIN, { ...row, postcode: "ls1 1aa" })).toBe(true);
      expect(await checkSuppressed(tx, ADMIN, { ...row, postcode: "LS1  1AA" })).toBe(true);
    });
  });

  it("flags a likely duplicate on name + postcode rather than inserting it", async () => {
    await withTestDb(async (tx) => {
      await scaffold(tx);
      await importRows(tx, ADMIN, [row], { dryRun: false, mode: "scraped" });
      const r = await importRows(tx, ADMIN, [{ ...row, phone: "0113 496 0999" }], { dryRun: false, mode: "scraped" });
      expect(r.duplicates).toBe(1);
      expect(await tx.select().from(listings)).toHaveLength(1);
    });
  });

  it("flags a duplicate on phone alone even when name and postcode differ", async () => {
    await withTestDb(async (tx) => {
      await scaffold(tx);
      await importRows(tx, ADMIN, [row], { dryRun: false, mode: "scraped" });
      const hit = await findDuplicate(tx, ADMIN, { ...row, name: "Old Barn Weddings", postcode: "LS9 9ZZ" });
      expect(hit?.reason).toMatch(/phone/);
    });
  });

  it("matches a duplicate phone written in a different format", async () => {
    await withTestDb(async (tx) => {
      await scaffold(tx);
      await importRows(tx, ADMIN, [row], { dryRun: false, mode: "scraped" });
      const hit = await findDuplicate(tx, ADMIN, { ...row, name: "Other", postcode: "LS9 9ZZ", phone: "01134960000" });
      expect(hit).not.toBeNull();
    });
  });

  it("writes nothing on a dry run but reports what it would do", async () => {
    await withTestDb(async (tx) => {
      await scaffold(tx);
      const r = await importRows(tx, ADMIN, [row], { dryRun: true, mode: "scraped" });
      expect(r.inserted).toBe(1);
      expect(await tx.select().from(listings)).toHaveLength(0);
    });
  });

  it("reports a mixed batch accurately", async () => {
    await withTestDb(async (tx) => {
      await scaffold(tx);
      await tx.insert(suppressions).values({
        nameNormalised: "blocked venue", postcodeNormalised: "ls22bb", reason: "x",
      });
      const r = await importRows(tx, ADMIN, [
        row,
        { ...row, name: "Blocked Venue", postcode: "LS2 2BB", phone: "0113 496 0001" },
        { ...row, name: "Copied Venue", postcode: "LS3 3CC", phone: "0113 496 0002", description: "copied" },
        { ...row, name: "The Old Barn", postcode: "LS1 1AA", phone: "0113 496 0003" },
      ], { dryRun: false, mode: "scraped" });
      expect(r).toMatchObject({ inserted: 1, suppressed: 1, rejected: 1, duplicates: 1 });
    });
  });
});

describe("resolveImportCity", () => {
  /**
   * Richmond is in North Yorkshire and in London; Newport is in Wales and on
   * the Isle of Wight. Resolving a city by name alone silently files half a
   * feed under the wrong town, and nobody notices until the addresses are
   * checked one by one.
   */
  async function twoRichmonds(tx: TestDb) {
    const verticalId = await makeVertical(tx);
    const north = await makeCity(tx, "Richmond", "North Yorkshire");
    const london = await makeCity(tx, "Richmond", "London");
    await makeCategoryInCity(tx, verticalId, north, "Barn Venues");
    return { north, london };
  }

  it("refuses to guess between two cities of the same name", async () => {
    await withTestDb(async (tx) => {
      await twoRichmonds(tx);
      await expect(resolveImportCity(tx, { ...row, city: "Richmond" }))
        .rejects.toThrow(/ambiguous/i);
    });
  });

  it("names both regions in the error so the file can be fixed", async () => {
    await withTestDb(async (tx) => {
      await twoRichmonds(tx);
      await expect(resolveImportCity(tx, { ...row, city: "Richmond" }))
        .rejects.toThrow(/London/);
    });
  });

  it("resolves the right one when the row carries a region", async () => {
    await withTestDb(async (tx) => {
      const { london } = await twoRichmonds(tx);
      expect(await resolveImportCity(tx, {
        ...row, city: "Richmond", region: "London",
      })).toBe(london);
    });
  });

  it("matches on case and surrounding whitespace, like the rest of the importer", async () => {
    await withTestDb(async (tx) => {
      const verticalId = await makeVertical(tx);
      const leeds = await makeCity(tx, "Leeds", "West Yorkshire");
      await makeCategoryInCity(tx, verticalId, leeds, "Barn Venues");
      expect(await resolveImportCity(tx, { ...row, city: "  leeds " })).toBe(leeds);
    });
  });

  it("throws a readable error for a town we do not hold", async () => {
    await withTestDb(async (tx) => {
      await scaffold(tx);
      await expect(resolveImportCity(tx, { ...row, city: "Atlantis" }))
        .rejects.toThrow(/Atlantis/);
    });
  });
});

describe("checkSuppressed without a postcode", () => {
  /**
   * A feed with no postcode column used to skip the suppression check
   * entirely, so a removal request could be undone by importing a file that
   * happened to omit one field.
   */
  it("still catches a suppressed business on name and phone", async () => {
    await withTestDb(async (tx) => {
      await tx.insert(suppressions).values({
        nameNormalised: "the old barn", phone: "0113 496 0000", reason: "removal request",
      });
      const { postcode: _postcode, ...noPostcode } = row;
      expect(await checkSuppressed(tx, ADMIN, noPostcode)).toBe(true);
    });
  });

  it("matches the phone however it was punctuated", async () => {
    await withTestDb(async (tx) => {
      await tx.insert(suppressions).values({
        nameNormalised: "the old barn", phone: "(0113) 496-0000", reason: "x",
      });
      const { postcode: _postcode, ...noPostcode } = row;
      expect(await checkSuppressed(tx, ADMIN, { ...noPostcode, phone: "01134960000" })).toBe(true);
    });
  });

  it("still catches a suppressed business on name and email", async () => {
    await withTestDb(async (tx) => {
      await tx.insert(suppressions).values({
        nameNormalised: "the old barn", email: "Hello@OldBarn.example", reason: "x",
      });
      const { postcode: _postcode, ...noPostcode } = row;
      expect(await checkSuppressed(tx, ADMIN, {
        ...noPostcode, phone: undefined, email: "hello@oldbarn.example",
      })).toBe(true);
    });
  });

  it("does not suppress a different business that shares neither contact point", async () => {
    await withTestDb(async (tx) => {
      await tx.insert(suppressions).values({
        nameNormalised: "the old barn", phone: "0113 496 0000", reason: "x",
      });
      const { postcode: _postcode, ...noPostcode } = row;
      expect(await checkSuppressed(tx, ADMIN, { ...noPostcode, phone: "0113 496 0999" })).toBe(false);
    });
  });

  it("cannot match on the name alone when there is nothing else to go on", async () => {
    await withTestDb(async (tx) => {
      await tx.insert(suppressions).values({
        nameNormalised: "the old barn", phone: "0113 496 0000", reason: "x",
      });
      const { postcode: _postcode, ...noPostcode } = row;
      expect(await checkSuppressed(tx, ADMIN, {
        ...noPostcode, phone: undefined, email: undefined,
      })).toBe(false);
    });
  });
});

describe("findDuplicate normalisation", () => {
  it("matches a name that differs only in case and spacing", async () => {
    await withTestDb(async (tx) => {
      await scaffold(tx);
      await importRows(tx, ADMIN, [row], { dryRun: false, mode: "scraped" });
      const hit = await findDuplicate(tx, ADMIN, {
        ...row, name: "  the OLD barn  ", phone: "0113 496 0999",
      });
      expect(hit?.reason).toMatch(/name and postcode/);
    });
  });

  it("matches a postcode retyped with different spacing or case", async () => {
    await withTestDb(async (tx) => {
      await scaffold(tx);
      await importRows(tx, ADMIN, [row], { dryRun: false, mode: "scraped" });
      const hit = await findDuplicate(tx, ADMIN, {
        ...row, postcode: "ls1  1aa", phone: "0113 496 0999",
      });
      expect(hit).not.toBeNull();
    });
  });

  it("does not flag a genuinely different business in the same town", async () => {
    await withTestDb(async (tx) => {
      await scaffold(tx);
      await importRows(tx, ADMIN, [row], { dryRun: false, mode: "scraped" });
      expect(await findDuplicate(tx, ADMIN, {
        ...row, name: "The New Barn", postcode: "LS9 9ZZ", phone: "0113 496 0999",
      })).toBeNull();
    });
  });
});

describe("importRows and the indexing gate", () => {
  it("opens the gate once an import clears the threshold", async () => {
    await withTestDb(async (tx) => {
      await scaffold(tx);
      await tx.update(cities).set({ introHtml: "<p>About Leeds.</p>" })
        .where(eq(cities.name, "Leeds"));

      const batch: ImportRow[] = Array.from(
        { length: siteConfig.seo.minListingsToIndex },
        (_, i) => ({ ...row, name: `Barn ${i}`, postcode: `LS${i} ${i}AA`, phone: `011349600${i}0` }),
      );
      await importRows(tx, ADMIN, batch, { dryRun: false, mode: "scraped" });

      const [city] = await tx.select().from(cities).where(eq(cities.name, "Leeds"));
      expect(city?.listingCount).toBe(siteConfig.seo.minListingsToIndex);
      expect(city?.isIndexable).toBe(true);
    });
  });

  it("leaves the gate shut when the import does not clear it", async () => {
    await withTestDb(async (tx) => {
      await scaffold(tx);
      await tx.update(cities).set({ introHtml: "<p>About Leeds.</p>" })
        .where(eq(cities.name, "Leeds"));
      await importRows(tx, ADMIN, [row], { dryRun: false, mode: "scraped" });

      const [city] = await tx.select().from(cities).where(eq(cities.name, "Leeds"));
      expect(city?.listingCount).toBe(1);
      expect(city?.isIndexable).toBe(false);
    });
  });

  it("touches nothing on a dry run", async () => {
    await withTestDb(async (tx) => {
      await scaffold(tx);
      await tx.update(cities)
        .set({ introHtml: "<p>About Leeds.</p>", listingCount: 7 })
        .where(eq(cities.name, "Leeds"));
      await importRows(tx, ADMIN, [row], { dryRun: true, mode: "scraped" });

      const [city] = await tx.select().from(cities).where(eq(cities.name, "Leeds"));
      expect(city?.listingCount).toBe(7);
    });
  });
});
