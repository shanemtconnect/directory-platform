import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { withTestDb } from "@/test/db";
import { listings } from "@/lib/db/schema";
import { PUBLIC_VIEWER } from "@/lib/db/viewer";
import { makeViewer } from "@/test/admin-fixtures";
import { makeScaffold, makeListing } from "@/test/factories";
import { decisionNotification } from "./notifications";

/**
 * The worker's read model for the approve/reject email. It is admin-only for
 * the same reason the rest of this module is: the row may be unpublished and
 * the address on it belongs to a member of the public.
 */
describe("decisionNotification", () => {
  it("returns who to write to, what about and where it now lives", async () => {
    await withTestDb(async (tx) => {
      const admin = await makeViewer(tx);
      const ctx = await makeScaffold(tx);
      const id = await makeListing(tx, ctx, {
        name: "The Old Mill",
        status: "published",
        submittedByEmail: "sam@example.co.uk",
        customFields: { submission: { submitterName: "Sam Owner", submitterEmail: "sam@example.co.uk" } },
      });

      const data = await decisionNotification(tx, admin, id);
      expect(data?.listingName).toBe("The Old Mill");
      expect(data?.cityName).toBe("Leeds");
      expect(data?.submitter).toEqual({ name: "Sam Owner", email: "sam@example.co.uk" });
      expect(data?.listingPath).toBe("/leeds/the-old-mill");
    });
  });

  it("prefers submitted_by_email over a different address in the stored blob", async () => {
    await withTestDb(async (tx) => {
      const admin = await makeViewer(tx);
      const ctx = await makeScaffold(tx);
      const id = await makeListing(tx, ctx, {
        name: "Two Addresses",
        status: "published",
        submittedByEmail: "authoritative@example.co.uk",
        customFields: {
          submission: { submitterName: "Blob Name", submitterEmail: "blob@example.co.uk" },
        },
      });

      const data = await decisionNotification(tx, admin, id);
      // The column is what the submission form wrote and what survives an
      // edit to custom_fields — it wins over a stale blob address.
      expect(data?.submitter.email).toBe("authoritative@example.co.uk");
    });
  });

  it("falls back to submitted_by_email when the stored blob has no address", async () => {
    await withTestDb(async (tx) => {
      const admin = await makeViewer(tx);
      const ctx = await makeScaffold(tx);
      const id = await makeListing(tx, ctx, {
        name: "No Blob",
        status: "rejected",
        rejectedReason: "Could not verify it.",
        submittedByEmail: "only@example.co.uk",
      });

      const data = await decisionNotification(tx, admin, id);
      // No name was ever given, so the address stands in for one rather than
      // the email opening "Thanks, null".
      expect(data?.submitter).toEqual({ name: "only@example.co.uk", email: "only@example.co.uk" });
      expect(data?.rejectedReason).toBe("Could not verify it.");
    });
  });

  it("is null when there is nobody to write to", async () => {
    await withTestDb(async (tx) => {
      const admin = await makeViewer(tx);
      const ctx = await makeScaffold(tx);
      const id = await makeListing(tx, ctx, { name: "Seeded" });
      await tx.update(listings).set({ submittedByEmail: null }).where(eq(listings.id, id));

      expect(await decisionNotification(tx, admin, id)).toBeNull();
    });
  });

  it("refuses anyone who is not the worker", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const id = await makeListing(tx, ctx);
      await expect(decisionNotification(tx, PUBLIC_VIEWER, id)).rejects.toThrow("FORBIDDEN");
    });
  });
});
