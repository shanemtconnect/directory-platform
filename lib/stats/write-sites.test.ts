import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { PUBLIC_VIEWER } from "@/lib/db/viewer";
import { withTestDb } from "@/test/db";
import { makeListing, makeScaffold } from "@/test/factories";

/**
 * `enquiries` and `shortlist_adds` are the two metrics a browser never
 * reports. They are counted where the row is written, so the number an owner
 * is shown is the number of rows in the table and nothing anyone can forge
 * from the internet — which is what makes it worth putting in front of them at
 * renewal.
 *
 * Real Redis, database 7.
 */
process.env.REDIS_URL = "redis://localhost:6380/3";

const { closeStatsRedis, statsRedis } = await import("./redis");
const { dayKey, statsKey } = await import("./keys");
const { createEnquiry } = await import("@/lib/db/queries/enquiries");
const {
  addListingToShortlist, createShortlistForCookie, newCookieId,
} = await import("@/lib/db/queries/shortlist");

async function clear(): Promise<void> {
  const c = await statsRedis();
  if (!c) throw new Error("redis db 3 is not reachable — start docker compose");
  await c.flushDb();
}

async function counter(listingId: string, metric: "enquiry" | "shortlist_add"): Promise<string | null> {
  const c = await statsRedis();
  return c!.get(statsKey(listingId, dayKey(new Date()), metric));
}

beforeEach(clear);
afterAll(async () => {
  await clear();
  await closeStatsRedis();
});

describe("enquiries count themselves", () => {
  it("increments the enquiry counter when the row is written", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const listingId = await makeListing(tx, ctx);

      await createEnquiry(tx, PUBLIC_VIEWER, {
        listingId, name: "A Visitor", email: "a@example.com",
        phone: null, message: "Is 14 June free?", ip: null,
      });

      expect(await counter(listingId, "enquiry")).toBe("1");
    });
  });

  it("counts nothing when the enquiry is refused", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const listingId = await makeListing(tx, ctx, { status: "draft" });

      const result = await createEnquiry(tx, PUBLIC_VIEWER, {
        listingId, name: "A Visitor", email: "a@example.com",
        phone: null, message: "Hello", ip: null,
      });

      expect(result.outcome).toBe("unknown-listing");
      expect(await counter(listingId, "enquiry")).toBeNull();
    });
  });
});

describe("shortlist saves count themselves", () => {
  it("increments the save counter when the item is inserted", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const listingId = await makeListing(tx, ctx);
      const list = await createShortlistForCookie(tx, PUBLIC_VIEWER, newCookieId());

      await addListingToShortlist(tx, PUBLIC_VIEWER, list.id, listingId);

      expect(await counter(listingId, "shortlist_add")).toBe("1");
    });
  });

  it("does not count a re-save of something already on the list", async () => {
    // Otherwise "saves" measures how often a visitor clicks, not how many
    // people kept the listing.
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const listingId = await makeListing(tx, ctx);
      const list = await createShortlistForCookie(tx, PUBLIC_VIEWER, newCookieId());

      await addListingToShortlist(tx, PUBLIC_VIEWER, list.id, listingId);
      await addListingToShortlist(tx, PUBLIC_VIEWER, list.id, listingId);

      expect(await counter(listingId, "shortlist_add")).toBe("1");
    });
  });
});
