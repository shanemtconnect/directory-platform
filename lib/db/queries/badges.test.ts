import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { withTestDb } from "@/test/db";
import { listings } from "@/lib/db/schema";
import { PUBLIC_VIEWER, type Viewer } from "@/lib/db/viewer";
import { makeListing, makeScaffold } from "@/test/factories";
import { badgeListing } from "./badges";

const ADMIN: Viewer = { role: "admin", userId: "00000000-0000-4000-8000-00000000adm1" };

describe("badgeListing", () => {
  it("returns the listing a public badge needs, with its canonical path parts", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const id = await makeListing(tx, ctx, {
        name: "The Old Mill",
        claimStatus: "verified",
        ratingAvg: "4.8",
        ratingCount: 27,
      });

      const row = await badgeListing(tx, PUBLIC_VIEWER, id);
      expect(row).toMatchObject({
        id,
        name: "The Old Mill",
        slug: "the-old-mill",
        claimStatus: "verified",
        ratingAvg: "4.8",
        ratingCount: 27,
        citySlug: "leeds",
        cityName: "Leeds",
        categoryName: "Barn Venues",
      });
    });
  });

  it("hides a listing that is not published — a badge is a public claim", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const id = await makeListing(tx, ctx, { name: "Pending Place" });
      await tx.update(listings).set({ status: "pending" }).where(eq(listings.id, id));

      expect(await badgeListing(tx, PUBLIC_VIEWER, id)).toBeNull();
    });
  });

  it("hides a removed listing too", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const id = await makeListing(tx, ctx, { name: "Gone Away" });
      await tx.update(listings).set({ status: "removed" }).where(eq(listings.id, id));

      expect(await badgeListing(tx, PUBLIC_VIEWER, id)).toBeNull();
    });
  });

  it("lets an admin see an unpublished listing, as everywhere else", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const id = await makeListing(tx, ctx, { name: "Pending Place" });
      await tx.update(listings).set({ status: "pending" }).where(eq(listings.id, id));

      expect((await badgeListing(tx, ADMIN, id))?.name).toBe("Pending Place");
    });
  });

  it("returns null for an id that is not a uuid, rather than throwing", async () => {
    await withTestDb(async (tx) => {
      await makeScaffold(tx);
      // Postgres answers a malformed uuid with an exception, which would leave
      // the badge route as a 500 on any hotlinked rubbish.
      expect(await badgeListing(tx, PUBLIC_VIEWER, "not-a-uuid")).toBeNull();
      expect(await badgeListing(tx, PUBLIC_VIEWER, "")).toBeNull();
    });
  });

  it("returns null for a uuid nothing matches", async () => {
    await withTestDb(async (tx) => {
      await makeScaffold(tx);
      expect(
        await badgeListing(tx, PUBLIC_VIEWER, "00000000-0000-4000-8000-000000000000"),
      ).toBeNull();
    });
  });
});
