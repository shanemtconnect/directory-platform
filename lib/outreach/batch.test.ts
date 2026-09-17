import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { withTestDb } from "@/test/db";
import {
  auditLog, campaigns, campaignMessages, coupons, profiles, unsubscribes, user,
} from "@/lib/db/schema";
import { PUBLIC_VIEWER, type Viewer } from "@/lib/db/viewer";
import { makeListing, makeScaffold } from "@/test/factories";
import { hashToken } from "@/lib/security/token-hash";
import { recordOutreachClick } from "@/lib/db/queries/outreach";
import { buildOutreachBatch } from "./batch";
import { outreachCsv, OUTREACH_CSV_HEADER } from "./csv";

const ADMIN: Viewer = { role: "admin", userId: "00000000-0000-4000-8000-00000000adm1" };

/** A profiles row, without dragging Better Auth's tables into the assertion. */
async function makeProfile(tx: Parameters<typeof buildOutreachBatch>[0]): Promise<string> {
  const userId = `u-${randomUUID()}`;
  await tx.insert(user).values({ id: userId, name: "Operator", email: `${userId}@example.com` });
  const [row] = await tx.insert(profiles).values({ userId }).returning({ id: profiles.id });
  return row!.id;
}

describe("buildOutreachBatch", () => {
  it("produces one row per candidate, each with its own token and coupon", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      for (let i = 0; i < 3; i++) {
        await makeListing(tx, ctx, { name: `Place ${i}`, email: `p${i}@example.com` });
      }

      const batch = await buildOutreachBatch(tx, ADMIN, {
        segment: {}, limit: 50, couponPercent: 50,
      });

      expect(batch.rows).toHaveLength(3);
      expect(new Set(batch.rows.map((r) => r.magicUrl)).size).toBe(3);
      expect(new Set(batch.rows.map((r) => r.couponCode)).size).toBe(3);
      for (const row of batch.rows) {
        expect(row.magicUrl).toContain("/claim/outreach/");
        expect(row.couponCode).toMatch(/^SAVE50-[A-Z0-9]{6}$/);
      }

      const messages = await tx
        .select()
        .from(campaignMessages)
        .where(eq(campaignMessages.campaignId, batch.campaignId!));
      expect(messages).toHaveLength(3);
      // The token in the file is the token whose digest is in the row, or the
      // link 404s. The file carries the RAW token: it is the link that is sent.
      const tokensInFile = batch.rows.map((r) => decodeURIComponent(r.magicUrl.split("/").pop()!));
      for (const message of messages) {
        expect(message.magicToken).toMatch(/^[0-9a-f]{64}$/);
        expect(tokensInFile.some((t) => hashToken(t) === message.magicToken)).toBe(true);
      }
      // And a link from the file works as sent.
      const first = batch.rows[0]!;
      const clicked = await recordOutreachClick(tx, PUBLIC_VIEWER, tokensInFile[0]!);
      expect(clicked).not.toBeNull();
      expect(messages.map((m) => m.listingId)).toContain(clicked!.listingId);
      expect(first.magicUrl).not.toContain(hashToken(tokensInFile[0]!));
      expect(await tx.select().from(coupons).where(eq(coupons.batchId, batch.batchId!))).toHaveLength(3);
    });
  });

  it("records the actor on the audit row and on every coupon", async () => {
    // `--actor` exists so a batch has a name against it: who pulled this list
    // of addresses, and who minted these discount codes.
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const actorProfileId = await makeProfile(tx);
      for (let i = 0; i < 2; i++) {
        await makeListing(tx, ctx, { name: `Place ${i}`, email: `p${i}@example.com` });
      }

      const batch = await buildOutreachBatch(tx, ADMIN, {
        segment: {}, limit: 50, couponPercent: 50, actorProfileId,
      });

      const [entry] = await tx
        .select()
        .from(auditLog)
        .where(eq(auditLog.entityId, batch.campaignId!));
      expect(entry?.actorId).toBe(actorProfileId);

      const minted = await tx.select().from(coupons).where(eq(coupons.batchId, batch.batchId!));
      expect(minted).toHaveLength(2);
      for (const coupon of minted) expect(coupon.createdBy).toBe(actorProfileId);
    });
  });

  it("mints codes for candidates, not for the limit", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      await makeListing(tx, ctx, { name: "Only One", email: "a@example.com" });

      const batch = await buildOutreachBatch(tx, ADMIN, {
        segment: {}, limit: 50, couponPercent: 50,
      });

      expect(await tx.select().from(coupons).where(eq(coupons.batchId, batch.batchId!))).toHaveLength(1);
    });
  });

  it("writes nothing at all when the segment is empty of candidates", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      await makeListing(tx, ctx, { name: "Opted Out", email: "gone@example.com" });
      await tx.insert(unsubscribes).values({ addressNormalised: "gone@example.com" });

      const batch = await buildOutreachBatch(tx, ADMIN, {
        segment: {}, limit: 50, couponPercent: 50,
      });

      expect(batch.rows).toEqual([]);
      expect(batch.campaignId).toBeNull();
      expect(await tx.select().from(campaigns)).toHaveLength(0);
      expect(await tx.select().from(coupons)).toHaveLength(0);
      expect(outreachCsv(batch.rows)).toBe(`${OUTREACH_CSV_HEADER}\r\n`);
    });
  });

  it("names the campaign after the segment it was built from", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      await makeListing(tx, ctx, { name: "One", email: "a@example.com" });

      const batch = await buildOutreachBatch(tx, ADMIN, {
        segment: { city: "leeds" }, limit: 50, couponPercent: 50,
      });

      const [campaign] = await tx
        .select()
        .from(campaigns)
        .where(eq(campaigns.id, batch.campaignId!));
      expect(campaign?.name).toContain("city=leeds");
      expect(campaign?.segment).toEqual({ city: "leeds" });
    });
  });

  it("is admin-only", async () => {
    await withTestDb(async (tx) => {
      await makeScaffold(tx);
      await expect(
        buildOutreachBatch(tx, PUBLIC_VIEWER, { segment: {}, limit: 1, couponPercent: 50 }),
      ).rejects.toThrow(/FORBIDDEN/);
    });
  });
});
