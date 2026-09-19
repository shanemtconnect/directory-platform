import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { withTestDb } from "@/test/db";
import { cities } from "@/lib/db/schema";
import { getListingDetail } from "./listing-detail";
import { PUBLIC_VIEWER } from "@/lib/db/viewer";
import { makeScaffold, makeListing } from "@/test/factories";

/**
 * The detail row is serialised into the RSC payload of every listing page, so
 * what it selects is what every visitor downloads. `select({ city: cities })`
 * shipped the CITY pillar page's `introHtml` — kilobytes of copy about a
 * different page — on every listing view.
 */
describe("getListingDetail projection", () => {
  it("never carries the city's pillar-page intro copy", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const listingId = await makeListing(tx, ctx, { name: "The Old Barn" });
      // Deliberately large: a real city's intro copy is a few kilobytes, and
      // this must not be in the payload however big it is.
      await tx
        .update(cities)
        .set({ introHtml: `<p>${"x".repeat(4000)}</p>`, metaDescription: "meta" })
        .where(eq(cities.id, ctx.cityId));

      const detail = await getListingDetail(tx, PUBLIC_VIEWER, listingId);
      expect(detail).not.toBeNull();
      expect(detail!.city).not.toHaveProperty("introHtml");
      expect(JSON.stringify(detail)).not.toContain("xxxx");
    });
  });

  it("selects only the city and category columns the page renders", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const listingId = await makeListing(tx, ctx, { name: "The Old Barn" });

      const detail = await getListingDetail(tx, PUBLIC_VIEWER, listingId);
      expect(detail).not.toBeNull();
      // Exact, not a subset: a column added back here is one nobody asked for.
      expect(Object.keys(detail!.city).sort())
        .toEqual(["country", "id", "name", "region", "slug"]);
      expect(Object.keys(detail!.category!).sort())
        .toEqual(["id", "name", "plural", "schemaTypeOverride", "singular", "slug"]);
      // The fields the page and the JSON-LD actually read still arrive.
      expect(detail!.city.name).toBe("Leeds");
      expect(detail!.city.country).toBe("GB");
      expect(detail!.category?.singular).toBeTruthy();
    });
  });
});
