import { describe, it, expect } from "vitest";
import { withTestDb } from "@/test/db";
import { runSeed, DEFAULT_NICHE } from "./seed";
import { cities, categories, listings, slugs } from "@/lib/db/schema";
import { resolveSlug, ROOT_SCOPE } from "@/lib/routing/slugs";
import { siteConfig } from "@/config/site.config";
import { eq, and } from "drizzle-orm";

/**
 * The seed directory is named after the entity, not the niche, so a clone
 * renames one folder and `pnpm seed` keeps working with no argument.
 */
const NICHE = DEFAULT_NICHE;

/** A two-city set where one city genuinely has no region. */
const FIXTURE = "__fixture__";

describe("runSeed", () => {
  it("loads 50 cities, 20 categories and 200 listings", async () => {
    await withTestDb(async (tx) => {
      const r = await runSeed(tx, NICHE);
      expect(r.cities).toBe(50);
      expect(r.categories).toBe(20);
      expect(r.listings).toBe(200);
      expect(await tx.select().from(cities)).toHaveLength(50);
      expect(await tx.select().from(categories)).toHaveLength(20);
      expect(await tx.select().from(listings)).toHaveLength(200);
    });
  }, 60000);

  it("is idempotent — running twice adds nothing", async () => {
    await withTestDb(async (tx) => {
      await runSeed(tx, NICHE);
      const second = await runSeed(tx, NICHE);
      expect(second.cities).toBe(0);
      expect(second.listings).toBe(0);
      expect(await tx.select().from(cities)).toHaveLength(50);
      expect(await tx.select().from(listings)).toHaveLength(200);
    });
  }, 90000);

  it("seeds no ratings and nothing verified", async () => {
    await withTestDb(async (tx) => {
      await runSeed(tx, NICHE);
      const rows = await tx.select().from(listings);
      expect(rows.every((r) => r.ratingAvg === null)).toBe(true);
      expect(rows.every((r) => r.ratingCount === 0)).toBe(true);
      expect(rows.every((r) => r.claimStatus === "unclaimed")).toBe(true);
      expect(rows.every((r) => r.tier === "free")).toBe(true);
    });
  }, 60000);

  it("leaves every city non-indexable until it earns it", async () => {
    await withTestDb(async (tx) => {
      await runSeed(tx, NICHE);
      expect((await tx.select().from(cities)).every((c) => c.isIndexable === false)).toBe(true);
    });
  }, 60000);

  it("disambiguates the two Richmonds rather than dropping one", async () => {
    await withTestDb(async (tx) => {
      await runSeed(tx, NICHE);
      const rows = await tx.select().from(cities).where(eq(cities.name, "Richmond"));
      expect(rows).toHaveLength(2);
      const slugsFound = rows.map((r) => r.slug).sort();
      expect(slugsFound[0]).toBe("richmond");
      expect(slugsFound[1]).toMatch(/^richmond-/);
    });
  }, 60000);

  it("allocates a slug row for every city and listing", async () => {
    await withTestDb(async (tx) => {
      await runSeed(tx, NICHE);
      expect(await tx.select().from(slugs).where(eq(slugs.kind, "city"))).toHaveLength(50);
      expect(await tx.select().from(slugs).where(eq(slugs.kind, "listing"))).toHaveLength(200);
    });
  }, 60000);

  it("routes each category inside every city where it has listings", async () => {
    await withTestDb(async (tx) => {
      await runSeed(tx, NICHE);
      const [aListing] = await tx.select().from(listings).limit(1);
      const row = await tx.select().from(slugs)
        .where(and(eq(slugs.parentScope, aListing!.cityId), eq(slugs.entityId, aListing!.primaryCategoryId)))
        .limit(1);
      expect(row[0]?.kind).toBe("category");
    });
  }, 60000);

  it("updates the denormalised listing_count the indexing gate reads", async () => {
    await withTestDb(async (tx) => {
      await runSeed(tx, NICHE);
      const rows = await tx.select().from(cities);
      const total = rows.reduce((n, c) => n + c.listingCount, 0);
      expect(total).toBe(200);
    });
  }, 60000);

  it("seeds the reserved slugs so a static route can never be shadowed", async () => {
    await withTestDb(async (tx) => {
      await runSeed(tx, NICHE);
      expect((await resolveSlug(tx, ROOT_SCOPE, "pricing"))?.kind).toBe("static");
      expect((await resolveSlug(tx, ROOT_SCOPE, "add-listing"))?.kind).toBe("static");
    });
  }, 60000);
});

describe("region", () => {
  it("stores a missing region as NULL, never an empty string", async () => {
    await withTestDb(async (tx) => {
      await runSeed(tx, FIXTURE);
      const rows = await tx.select().from(cities);
      expect(rows).toHaveLength(2);

      const singapore = rows.find((c) => c.name === "Singapore");
      // An empty string here renders an empty <h2> on /cities and makes the
      // "City, Region" heading read "Singapore, ".
      expect(singapore?.region).toBeNull();
      expect(rows.find((c) => c.name === "Orchard")?.region).toBe("Central");
    });
  }, 60000);

  it("does not re-insert a region-less city on a second run", async () => {
    await withTestDb(async (tx) => {
      await runSeed(tx, FIXTURE);
      const second = await runSeed(tx, FIXTURE);
      expect(second.cities).toBe(0);
      expect(await tx.select().from(cities)).toHaveLength(2);
    });
  }, 60000);

  it("keeps same-named cities in different regions apart when placing listings", async () => {
    await withTestDb(async (tx) => {
      await runSeed(tx, NICHE);
      const both = await tx.select().from(cities).where(eq(cities.name, "Richmond"));
      expect(both).toHaveLength(2);
      // The listings CSV carries a region column precisely so neither Richmond
      // swallows the other's rows.
      for (const city of both) {
        expect(city.listingCount, `${city.slug} has no listings`).toBeGreaterThan(0);
      }
    });
  }, 60000);
});

describe("listing descriptions", () => {
  it("name the listing's own city and its own category", async () => {
    await withTestDb(async (tx) => {
      await runSeed(tx, NICHE);
      const rows = await tx
        .select({
          description: listings.shortDescription,
          city: cities.name,
          category: categories.singular,
        })
        .from(listings)
        .innerJoin(cities, eq(cities.id, listings.cityId))
        .innerJoin(categories, eq(categories.id, listings.primaryCategoryId));

      expect(rows).toHaveLength(200);
      for (const row of rows) {
        expect(row.description, "every listing needs a description").toBeTruthy();
        expect(
          row.description,
          `${row.description} does not mention its own city ${row.city}`,
        ).toContain(row.city);
        expect(
          row.description,
          `${row.description} does not mention its own category ${row.category}`,
        ).toContain(row.category);
      }
    });
  }, 60000);
});

describe("city intro copy", () => {
  it("writes real copy for every city, built from that city's own facts", async () => {
    await withTestDb(async (tx) => {
      await runSeed(tx, NICHE);
      const rows = await tx.select().from(cities);

      for (const city of rows) {
        const intro = city.introHtml;
        expect(intro, `${city.name} has no intro copy`).toBeTruthy();
        expect(intro).toContain(city.name);
        if (city.region) expect(intro).toContain(city.region);
        // Two paragraphs, not a placeholder. The indexing gate only checks for
        // NOT NULL, so filler here is how a thin site talks itself into being
        // indexed.
        expect((intro!.match(/<p>/g) ?? []).length).toBeGreaterThanOrEqual(2);
        expect(intro!.length).toBeGreaterThan(120);
      }
    });
  }, 60000);

  it("uses the nouns from siteConfig.entity, so a clone reads correctly", async () => {
    await withTestDb(async (tx) => {
      await runSeed(tx, NICHE);
      const [city] = await tx.select().from(cities).where(eq(cities.slug, "leeds"));
      const intro = city!.introHtml!;
      expect(intro).toContain(siteConfig.entity.plural);
      expect(intro).toContain(siteConfig.name);
    });
  }, 60000);

  it("escapes ampersands so a category name cannot break the markup", async () => {
    await withTestDb(async (tx) => {
      await runSeed(tx, NICHE);
      const rows = await tx.select().from(cities);
      for (const city of rows) {
        expect(city.introHtml, `${city.name} has a bare & in its intro copy`)
          .not.toMatch(/&(?!amp;|lt;|gt;|quot;|#39;)/);
      }
    });
  }, 60000);

  it("never overwrites intro copy an editor has already written", async () => {
    await withTestDb(async (tx) => {
      await runSeed(tx, NICHE);
      await tx.update(cities).set({ introHtml: "<p>Hand written.</p>" })
        .where(eq(cities.slug, "leeds"));
      await runSeed(tx, NICHE);
      const [leeds] = await tx.select().from(cities).where(eq(cities.slug, "leeds"));
      expect(leeds!.introHtml).toBe("<p>Hand written.</p>");
    });
  }, 90000);
});

describe("the indexing gate has something to bite on", () => {
  it("gives all but three cities enough listings to clear the threshold", async () => {
    await withTestDb(async (tx) => {
      await runSeed(tx, NICHE);
      const rows = await tx.select().from(cities);
      const thin = rows.filter((c) => c.listingCount < siteConfig.seo.minListingsToIndex);

      // Three, deliberately: a seed where every city passes proves nothing
      // about the gate, and a seed where a dozen fail is just bad data.
      expect(thin.map((c) => c.slug).sort()).toHaveLength(3);
      expect(rows.every((c) => c.listingCount > 0)).toBe(true);
    });
  }, 60000);

  it("leaves the thin cities blocked on the count alone, not on missing copy", async () => {
    await withTestDb(async (tx) => {
      await runSeed(tx, NICHE);
      const rows = await tx.select().from(cities);
      const thin = rows.filter((c) => c.listingCount < siteConfig.seo.minListingsToIndex);
      expect(thin.every((c) => c.introHtml !== null)).toBe(true);
    });
  }, 60000);
});
