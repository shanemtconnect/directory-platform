import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { withTestDb } from "@/test/db";
import { auditLog, unsubscribes } from "@/lib/db/schema";
import { PUBLIC_VIEWER } from "@/lib/db/viewer";
import { makeListing, makeScaffold } from "@/test/factories";
import { selectQuoteRecipients } from "./quotes";
import { recordUnsubscribe } from "./unsubscribes";

const LISTING = "33333333-3333-4333-8333-333333333333";

describe("recordUnsubscribe", () => {
  it("writes the normalised address once, with one audit row, and a second click is a no-op", async () => {
    await withTestDb(async (tx) => {
      const first = await recordUnsubscribe(tx, PUBLIC_VIEWER, {
        email: "  Owner@Example.com ", listingId: LISTING, reason: "quote", ip: "203.0.113.9",
      });
      expect(first).toEqual({ written: true });
      const again = await recordUnsubscribe(tx, PUBLIC_VIEWER, {
        email: "owner@example.com", listingId: LISTING, reason: "quote", ip: null,
      });
      expect(again).toEqual({ written: false });

      const rows = await tx.select().from(unsubscribes)
        .where(eq(unsubscribes.addressNormalised, "owner@example.com"));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.reason).toBe("quote");

      const audits = await tx.select().from(auditLog).where(eq(auditLog.action, "email.unsubscribed"));
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ entityType: "listing", entityId: LISTING, ip: "203.0.113.9", actorId: null });
    });
  });

  it("takes the address out of the next broadcast", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const gone = await makeListing(tx, ctx, { email: "Gone@Example.com", tier: "premium" });
      const stays = await makeListing(tx, ctx, { email: "stays@example.com" });
      await recordUnsubscribe(tx, PUBLIC_VIEWER, { email: "gone@example.com", listingId: gone, reason: "quote", ip: null });

      const chosen = await selectQuoteRecipients(tx, PUBLIC_VIEWER, {
        cityId: ctx.cityId, categoryId: ctx.primaryCategoryId, limit: 5,
      });
      expect(chosen.map((c) => c.listingId)).toEqual([stays]);
    });
  });
});
