import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { withTestDb, type TestDb } from "@/test/db";
import { enquiries, listings } from "@/lib/db/schema";
import { PUBLIC_VIEWER, type Viewer } from "@/lib/db/viewer";
import { makeListing, makeScaffold } from "@/test/factories";
import { createEnquiry, type EnquiryInput } from "./enquiries";

const ADMIN: Viewer = { role: "admin", userId: "00000000-0000-4000-8000-00000000adm1" };

function input(listingId: string, patch: Partial<EnquiryInput> = {}): EnquiryInput {
  return {
    listingId,
    name: "Sam Enquirer",
    email: "sam@example.co.uk",
    phone: "01632 960000",
    message: "We are looking for somewhere for about eighty people in June.",
    ip: "198.51.100.4",
    ...patch,
  };
}

async function countEnquiries(tx: TestDb, listingId: string): Promise<number> {
  const rows = await tx.select().from(enquiries).where(eq(enquiries.listingId, listingId));
  return rows.length;
}

async function enquiryCount(tx: TestDb, listingId: string): Promise<number> {
  const [row] = await tx
    .select({ n: listings.enquiryCount })
    .from(listings)
    .where(eq(listings.id, listingId))
    .limit(1);
  return row?.n ?? -1;
}

describe("createEnquiry", () => {
  it("stores the enquiry and bumps the listing's counter", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const listingId = await makeListing(tx, ctx, { name: "The Old Mill" });

      const result = await createEnquiry(tx, PUBLIC_VIEWER, input(listingId));
      expect(result.outcome).toBe("created");

      const [row] = await tx.select().from(enquiries).where(eq(enquiries.listingId, listingId));
      expect(row).toMatchObject({
        name: "Sam Enquirer",
        email: "sam@example.co.uk",
        phone: "01632 960000",
        ip: "198.51.100.4",
        isSpam: false,
      });
      expect(await enquiryCount(tx, listingId)).toBe(1);
    });
  });

  it("stores no IP at all rather than a placeholder when there is none", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const listingId = await makeListing(tx, ctx, { name: "The Old Mill" });

      await createEnquiry(tx, PUBLIC_VIEWER, input(listingId, { ip: null, phone: null }));
      const [row] = await tx.select().from(enquiries).where(eq(enquiries.listingId, listingId));
      expect(row?.ip).toBeNull();
      expect(row?.phone).toBeNull();
    });
  });

  it("refuses a pending listing — a listing not yet live must not collect leads", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const listingId = await makeListing(tx, ctx, { name: "Pending Place" });
      await tx.update(listings).set({ status: "pending" }).where(eq(listings.id, listingId));

      expect(await createEnquiry(tx, PUBLIC_VIEWER, input(listingId))).toEqual({
        outcome: "unknown-listing",
      });
      expect(await countEnquiries(tx, listingId)).toBe(0);
      expect(await enquiryCount(tx, listingId)).toBe(0);
    });
  });

  it("refuses a removed listing", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const listingId = await makeListing(tx, ctx, { name: "Gone Away" });
      await tx.update(listings).set({ status: "removed" }).where(eq(listings.id, listingId));

      expect((await createEnquiry(tx, PUBLIC_VIEWER, input(listingId))).outcome)
        .toBe("unknown-listing");
      expect(await countEnquiries(tx, listingId)).toBe(0);
    });
  });

  it("refuses an id that is not a uuid, rather than throwing", async () => {
    await withTestDb(async (tx) => {
      await makeScaffold(tx);
      expect((await createEnquiry(tx, PUBLIC_VIEWER, input("not-a-uuid"))).outcome)
        .toBe("unknown-listing");
    });
  });

  it("refuses a uuid nothing matches", async () => {
    await withTestDb(async (tx) => {
      await makeScaffold(tx);
      const result = await createEnquiry(
        tx,
        PUBLIC_VIEWER,
        input("00000000-0000-4000-8000-000000000000"),
      );
      expect(result.outcome).toBe("unknown-listing");
    });
  });

  it("lets an admin reach an unpublished listing, as everywhere else in this layer", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const listingId = await makeListing(tx, ctx, { name: "Pending Place" });
      await tx.update(listings).set({ status: "pending" }).where(eq(listings.id, listingId));

      expect((await createEnquiry(tx, ADMIN, input(listingId))).outcome).toBe("created");
    });
  });
});
