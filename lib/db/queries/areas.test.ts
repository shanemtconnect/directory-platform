import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { withTestDb, type TestDb } from "@/test/db";
import { makeCategoryInCity, makeCity, makeListing, makeVertical } from "@/test/factories";
import { cities, redirects } from "@/lib/db/schema";
import { PUBLIC_VIEWER, type Viewer } from "@/lib/db/viewer";
import { resolveSlug, REGION_SCOPE } from "@/lib/routing/slugs";
import { PER_PAGE } from "./listings";
import {
  listRegions, regionBySlug, listRegionListings, countRegionListings,
  topCategoriesInRegion, sitemapRegions, registerRegionSlugs, renameRegion,
  regionPaths,
} from "./areas";

const ADMIN: Viewer = { role: "admin", userId: "admin-1" };

/** A city that has cleared the gate: intro copy plus the flag the seed's recompute would set. */
async function indexable(tx: TestDb, cityId: string): Promise<void> {
  await tx.update(cities)
    .set({ isIndexable: true, introHtml: "<p>Intro.</p>", listingCount: 3 })
    .where(eq(cities.id, cityId));
}

/**
 * Two regions. West Yorkshire has one indexable city (Leeds, 2 listings) and
 * one thin city (Wakefield, 1 listing, not indexable). North Yorkshire has one
 * thin city only. Plus an unpublished city and a city with no region at all.
 */
async function scaffold(tx: TestDb) {
  const verticalId = await makeVertical(tx);
  const leeds = await makeCity(tx, "Leeds", "West Yorkshire");
  const wakefield = await makeCity(tx, "Wakefield", "West Yorkshire");
  const york = await makeCity(tx, "York", "North Yorkshire");
  const hidden = await makeCity(tx, "Hidden", "West Yorkshire");
  await tx.update(cities).set({ isPublished: false }).where(eq(cities.id, hidden));
  const nowhere = await makeCity(tx, "Nowhere", null);
  await indexable(tx, leeds);

  const barns = await makeCategoryInCity(tx, verticalId, leeds, "Barn Venues");
  const hotels = await makeCategoryInCity(tx, verticalId, leeds, "Hotel Venues");
  await makeListing(tx, { cityId: leeds, verticalId, primaryCategoryId: barns }, { name: "Leeds Barn" });
  await makeListing(tx, { cityId: leeds, verticalId, primaryCategoryId: hotels }, { name: "Leeds Hotel" });
  await makeListing(tx, { cityId: leeds, verticalId, primaryCategoryId: barns }, { name: "Leeds Draft", status: "pending" });
  await makeListing(tx, { cityId: wakefield, verticalId, primaryCategoryId: barns }, { name: "Wakefield Barn" });
  await makeListing(tx, { cityId: york, verticalId, primaryCategoryId: barns }, { name: "York Barn" });
  await makeListing(tx, { cityId: hidden, verticalId, primaryCategoryId: barns }, { name: "Hidden Barn" });
  await makeListing(tx, { cityId: nowhere, verticalId, primaryCategoryId: barns }, { name: "Nowhere Barn" });
  return { verticalId, leeds, wakefield, york, barns, hotels };
}

describe("listRegions", () => {
  it("groups published cities by region with city and published-listing counts", async () => {
    await withTestDb(async (tx) => {
      await scaffold(tx);
      const rows = await listRegions(tx, ADMIN);
      expect(rows.map((r) => r.slug)).toEqual(["west-yorkshire", "north-yorkshire"]);
      const wy = rows[0]!;
      expect(wy).toMatchObject({
        name: "West Yorkshire", cityCount: 2, indexableCityCount: 1, isIndexable: true,
      });
      // An admin counts every listing; the public count is the published one.
      expect(wy.listingCount).toBe(4);
      expect(rows[1]).toMatchObject({
        name: "North Yorkshire", cityCount: 1, indexableCityCount: 0, isIndexable: false, listingCount: 1,
      });
    });
  });

  it("shows the public only regions with at least one indexable city, counting published listings", async () => {
    await withTestDb(async (tx) => {
      await scaffold(tx);
      const rows = await listRegions(tx, PUBLIC_VIEWER);
      expect(rows.map((r) => r.slug)).toEqual(["west-yorkshire"]);
      expect(rows[0]!.listingCount).toBe(3);
    });
  });

  it("ignores cities with no region rather than inventing an 'Other' region", async () => {
    await withTestDb(async (tx) => {
      await scaffold(tx);
      const rows = await listRegions(tx, ADMIN);
      expect(rows.some((r) => r.name === "Other" || r.slug === "")).toBe(false);
    });
  });
});

describe("regionBySlug", () => {
  it("resolves a slug to the region, its cities (busiest first) and the indexing decision", async () => {
    await withTestDb(async (tx) => {
      await scaffold(tx);
      const region = await regionBySlug(tx, PUBLIC_VIEWER, "west-yorkshire");
      expect(region).not.toBeNull();
      expect(region!.name).toBe("West Yorkshire");
      expect(region!.isIndexable).toBe(true);
      expect(region!.cities.map((c) => [c.name, c.listingCount, c.isIndexable])).toEqual([
        ["Leeds", 2, true],
        ["Wakefield", 1, false],
      ]);
    });
  });

  it("returns null for a slug no published city carries, and for the wrong case", async () => {
    await withTestDb(async (tx) => {
      await scaffold(tx);
      expect(await regionBySlug(tx, PUBLIC_VIEWER, "south-yorkshire")).toBeNull();
      expect(await regionBySlug(tx, PUBLIC_VIEWER, "West-Yorkshire")).toBeNull();
    });
  });

  it("is not indexable when no city in it has earned indexing", async () => {
    await withTestDb(async (tx) => {
      await scaffold(tx);
      const region = await regionBySlug(tx, PUBLIC_VIEWER, "north-yorkshire");
      expect(region?.isIndexable).toBe(false);
    });
  });
});

describe("region listings", () => {
  it("lists and counts the published listings across the region's published cities, with each city's slug", async () => {
    await withTestDb(async (tx) => {
      await scaffold(tx);
      const region = (await regionBySlug(tx, PUBLIC_VIEWER, "west-yorkshire"))!;
      const rows = await listRegionListings(tx, PUBLIC_VIEWER, region.names);
      expect(rows.map((r) => r.listing.name).sort()).toEqual(["Leeds Barn", "Leeds Hotel", "Wakefield Barn"]);
      expect(rows.find((r) => r.listing.name === "Wakefield Barn")?.citySlug).toBe("wakefield");
      expect(await countRegionListings(tx, PUBLIC_VIEWER, region.names)).toBe(3);
      // Never the submitter's private fields.
      expect(Object.keys(rows[0]!.listing)).not.toContain("submittedByEmail");
    });
  });

  it("paginates with the pillar PER_PAGE", async () => {
    await withTestDb(async (tx) => {
      const { verticalId, leeds, barns } = await scaffold(tx);
      for (let i = 0; i < PER_PAGE; i++) {
        await makeListing(tx, { cityId: leeds, verticalId, primaryCategoryId: barns });
      }
      const names = ["West Yorkshire"];
      expect(await countRegionListings(tx, PUBLIC_VIEWER, names)).toBe(PER_PAGE + 3);
      expect(await listRegionListings(tx, PUBLIC_VIEWER, names, { page: 1 })).toHaveLength(PER_PAGE);
      expect(await listRegionListings(tx, PUBLIC_VIEWER, names, { page: 2 })).toHaveLength(3);
      expect(await listRegionListings(tx, PUBLIC_VIEWER, names, { page: 3 })).toHaveLength(0);
    });
  });

  it("ranks the region's categories by published count, linking the national slug", async () => {
    await withTestDb(async (tx) => {
      await scaffold(tx);
      const cats = await topCategoriesInRegion(tx, PUBLIC_VIEWER, ["West Yorkshire"]);
      expect(cats.map((c) => [c.name, c.slug, c.listingCount])).toEqual([
        ["Barn Venues", "barn-venues", 2],
        ["Hotel Venues", "hotel-venues", 1],
      ]);
    });
  });
});

describe("sitemapRegions", () => {
  it("advertises indexable regions only, whatever the viewer", async () => {
    await withTestDb(async (tx) => {
      await scaffold(tx);
      for (const viewer of [PUBLIC_VIEWER, ADMIN]) {
        const entries = await sitemapRegions(tx, viewer);
        expect(entries.map((e) => e.path)).toEqual(["/areas/west-yorkshire"]);
        expect(entries[0]!.lastModified).toBeInstanceOf(Date);
      }
    });
  });
});

describe("registerRegionSlugs", () => {
  it("registers every distinct region in the registry, idempotently", async () => {
    await withTestDb(async (tx) => {
      await scaffold(tx);
      expect((await registerRegionSlugs(tx)).sort()).toEqual(["north-yorkshire", "west-yorkshire"]);
      expect((await registerRegionSlugs(tx)).sort()).toEqual(["north-yorkshire", "west-yorkshire"]);
      expect((await resolveSlug(tx, REGION_SCOPE, "west-yorkshire"))?.kind).toBe("region");
    });
  });
});

describe("renameRegion", () => {
  it("renames every city's region, re-registers the slug and 301s the old page", async () => {
    await withTestDb(async (tx) => {
      await scaffold(tx);
      await registerRegionSlugs(tx);

      const slug = await renameRegion(tx, ADMIN, { from: "West Yorkshire", to: "Yorkshire (West)" });
      expect(slug).toBe("yorkshire-west");

      expect(await regionBySlug(tx, PUBLIC_VIEWER, "west-yorkshire")).toBeNull();
      expect((await regionBySlug(tx, PUBLIC_VIEWER, "yorkshire-west"))?.cities.map((c) => c.name)).toEqual(["Leeds", "Wakefield"]);
      expect(await resolveSlug(tx, REGION_SCOPE, "west-yorkshire")).toBeNull();
      expect((await resolveSlug(tx, REGION_SCOPE, "yorkshire-west"))?.kind).toBe("region");

      const [r] = await tx.select().from(redirects).where(eq(redirects.fromPath, "/areas/west-yorkshire"));
      expect(r).toMatchObject({ toPath: "/areas/yorkshire-west", statusCode: 301 });
    });
  });

  it("collapses a redirect chain so a twice-renamed region is one hop", async () => {
    await withTestDb(async (tx) => {
      await scaffold(tx);
      await registerRegionSlugs(tx);
      await renameRegion(tx, ADMIN, { from: "West Yorkshire", to: "West Yorks" });
      await renameRegion(tx, ADMIN, { from: "West Yorks", to: "Yorkshire West" });
      const rows = await tx.select().from(redirects);
      const byFrom = new Map(rows.map((r) => [r.fromPath, r.toPath]));
      expect(byFrom.get("/areas/west-yorkshire")).toBe("/areas/yorkshire-west");
      expect(byFrom.get("/areas/west-yorks")).toBe("/areas/yorkshire-west");
    });
  });

  it("is a no-op when the new name slugifies the same, and refuses non-admins", async () => {
    await withTestDb(async (tx) => {
      await scaffold(tx);
      await registerRegionSlugs(tx);
      expect(await renameRegion(tx, ADMIN, { from: "West Yorkshire", to: "West  Yorkshire" })).toBe("west-yorkshire");
      expect(await tx.select().from(redirects)).toHaveLength(0);
      await expect(renameRegion(tx, PUBLIC_VIEWER, { from: "West Yorkshire", to: "X" })).rejects.toThrow("FORBIDDEN");
    });
  });
});

describe("regionPaths", () => {
  it("is the region page plus every paginated page that exists, allowing one more listing", async () => {
    await withTestDb(async (tx) => {
      const { verticalId, leeds, barns } = await scaffold(tx);
      // 3 published in West Yorkshire; PER_PAGE - 3 more makes exactly one
      // page, and the +1 allowance means page 2 is busted too.
      for (let i = 0; i < PER_PAGE - 3; i++) {
        await makeListing(tx, { cityId: leeds, verticalId, primaryCategoryId: barns });
      }
      expect(await regionPaths(tx, "West Yorkshire")).toEqual([
        "/areas/west-yorkshire", "/areas/west-yorkshire/page/2",
      ]);
      expect(await regionPaths(tx, null)).toEqual([]);
    });
  });
});
