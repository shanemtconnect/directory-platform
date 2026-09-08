import { describe, it, expect } from "vitest";
import { withTestDb, type TestDb } from "@/test/db";
import { importRows, checkSuppressed, findDuplicate, type ImportRow } from "./guardrails";
import { suppressions, listings, cities, categories } from "@/lib/db/schema";
import { makeVertical, makeCity, makeCategoryInCity } from "@/test/factories";
import { eq } from "drizzle-orm";

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
      await importRows(tx, [row], { dryRun: false, mode: "scraped" });
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
      await importRows(tx, [row], { dryRun: false, mode: "scraped" });
      const [l] = await tx.select().from(listings);
      expect(l?.sourceUrl).toBe("https://register.example/123");
      expect(l?.importedAt).toBeInstanceOf(Date);
    });
  });

  it("rejects a description in scraped mode — facts only", async () => {
    await withTestDb(async (tx) => {
      await scaffold(tx);
      const r = await importRows(tx, [{ ...row, description: "A stunning converted..." }],
        { dryRun: false, mode: "scraped" });
      expect(r.rejected).toBe(1);
      expect(await tx.select().from(listings)).toHaveLength(0);
    });
  });

  it("keeps a description in authored mode and marks the source as import", async () => {
    await withTestDb(async (tx) => {
      await scaffold(tx);
      await importRows(tx, [{ ...row, description: "A restored barn. It sleeps 40." }],
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
      await importRows(tx, [{ ...row, description: "Written copy." }], { dryRun: false, mode: "authored" });
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
      expect(await checkSuppressed(tx, row)).toBe(true);
      const r = await importRows(tx, [row], { dryRun: false, mode: "scraped" });
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
      expect(await checkSuppressed(tx, { ...row, postcode: "ls1 1aa" })).toBe(true);
      expect(await checkSuppressed(tx, { ...row, postcode: "LS1  1AA" })).toBe(true);
    });
  });

  it("flags a likely duplicate on name + postcode rather than inserting it", async () => {
    await withTestDb(async (tx) => {
      await scaffold(tx);
      await importRows(tx, [row], { dryRun: false, mode: "scraped" });
      const r = await importRows(tx, [{ ...row, phone: "0113 496 0999" }], { dryRun: false, mode: "scraped" });
      expect(r.duplicates).toBe(1);
      expect(await tx.select().from(listings)).toHaveLength(1);
    });
  });

  it("flags a duplicate on phone alone even when name and postcode differ", async () => {
    await withTestDb(async (tx) => {
      await scaffold(tx);
      await importRows(tx, [row], { dryRun: false, mode: "scraped" });
      const hit = await findDuplicate(tx, { ...row, name: "Old Barn Weddings", postcode: "LS9 9ZZ" });
      expect(hit?.reason).toMatch(/phone/);
    });
  });

  it("matches a duplicate phone written in a different format", async () => {
    await withTestDb(async (tx) => {
      await scaffold(tx);
      await importRows(tx, [row], { dryRun: false, mode: "scraped" });
      const hit = await findDuplicate(tx, { ...row, name: "Other", postcode: "LS9 9ZZ", phone: "01134960000" });
      expect(hit).not.toBeNull();
    });
  });

  it("writes nothing on a dry run but reports what it would do", async () => {
    await withTestDb(async (tx) => {
      await scaffold(tx);
      const r = await importRows(tx, [row], { dryRun: true, mode: "scraped" });
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
      const r = await importRows(tx, [
        row,
        { ...row, name: "Blocked Venue", postcode: "LS2 2BB", phone: "0113 496 0001" },
        { ...row, name: "Copied Venue", postcode: "LS3 3CC", phone: "0113 496 0002", description: "copied" },
        { ...row, name: "The Old Barn", postcode: "LS1 1AA", phone: "0113 496 0003" },
      ], { dryRun: false, mode: "scraped" });
      expect(r).toMatchObject({ inserted: 1, suppressed: 1, rejected: 1, duplicates: 1 });
    });
  });
});
