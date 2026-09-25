import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/lib/db/schema";
import { auditLog, creditLedger, profiles, user } from "@/lib/db/schema";
import { withTestDb, type TestDb } from "@/test/db";
import type { Viewer } from "@/lib/db/viewer";
import {
  InsufficientCredit,
  adminAdjust,
  creditBalance,
  creditBalances,
  creditLedgerFor,
  debitForPurchase,
  postLedger,
  profileIdByEmail,
  refundToCredit,
} from "./credits";

const SYSTEM: Viewer = { role: "admin", userId: "00000000-0000-0000-0000-000000000000" };

/** A Better Auth user with its profile; returns the viewer and the profile id the ledger keys on. */
async function makeAccount(tx: TestDb, role: "user" | "admin" = "user"): Promise<{ viewer: Viewer; profileId: string }> {
  const id = `u_${randomUUID()}`;
  await tx.insert(user).values({ id, name: "Credit Tester", email: `${id}@example.com` });
  const [p] = await tx.insert(profiles).values({ userId: id, role }).returning({ id: profiles.id });
  return { viewer: role === "admin" ? { role: "admin", userId: id } : { role: "user", userId: id }, profileId: p!.id };
}

async function topUp(tx: TestDb, userId: string, cents: number, orderId: string | null = null): Promise<void> {
  await postLedger(tx, SYSTEM, { userId, deltaCents: cents, kind: "topup", orderId });
}

describe("creditBalance", () => {
  it("is the sum of the ledger, zero for an account with none", async () => {
    await withTestDb(async (tx) => {
      const { profileId } = await makeAccount(tx);
      expect(await creditBalance(tx, profileId)).toBe(0);
      await topUp(tx, profileId, 5000);
      await topUp(tx, profileId, 10000);
      expect(await creditBalance(tx, profileId)).toBe(15000);
    });
  });
});

describe("postLedger", () => {
  it("posts an order at most once: a second entry for the same order_id is refused, not duplicated", async () => {
    await withTestDb(async (tx) => {
      const { profileId } = await makeAccount(tx);
      expect(await postLedger(tx, SYSTEM, { userId: profileId, deltaCents: 5000, kind: "topup", orderId: "ORDER-1" })).not.toBeNull();
      expect(await postLedger(tx, SYSTEM, { userId: profileId, deltaCents: 5000, kind: "topup", orderId: "ORDER-1" })).toBeNull();
      expect(await creditBalance(tx, profileId)).toBe(5000);
    });
  });

  it("is the system's alone", async () => {
    await withTestDb(async (tx) => {
      const { viewer, profileId } = await makeAccount(tx);
      await expect(postLedger(tx, viewer, { userId: profileId, deltaCents: 5000, kind: "topup" })).rejects.toThrow(/FORBIDDEN/);
    });
  });
});

describe("debitForPurchase", () => {
  it("takes the price and records the lead", async () => {
    await withTestDb(async (tx) => {
      const { viewer, profileId } = await makeAccount(tx);
      await topUp(tx, profileId, 5000);
      const leadId = randomUUID();
      const out = await debitForPurchase(tx, viewer, { userId: profileId, cents: 2500, leadId });
      expect(out.balanceCents).toBe(2500);
      const [row] = await tx.select().from(creditLedger).where(eq(creditLedger.id, out.entryId));
      expect(row).toMatchObject({ deltaCents: -2500, kind: "purchase", refType: "lead", refId: leadId });
    });
  });

  it("throws InsufficientCredit and writes nothing when the balance is short — never a partial debit", async () => {
    await withTestDb(async (tx) => {
      const { viewer, profileId } = await makeAccount(tx);
      await topUp(tx, profileId, 2000);
      const err = await debitForPurchase(tx, viewer, { userId: profileId, cents: 2500, leadId: randomUUID() }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(InsufficientCredit);
      expect(err).toMatchObject({ balanceCents: 2000, neededCents: 2500 });
      expect(await creditBalance(tx, profileId)).toBe(2000);
    });
  });

  it("refuses a viewer spending somebody else's credit, and a non-positive amount", async () => {
    await withTestDb(async (tx) => {
      const owner = await makeAccount(tx);
      const stranger = await makeAccount(tx);
      await topUp(tx, owner.profileId, 5000);
      await expect(debitForPurchase(tx, stranger.viewer, { userId: owner.profileId, cents: 100, leadId: randomUUID() })).rejects.toThrow(/FORBIDDEN/);
      await expect(debitForPurchase(tx, { role: "public" }, { userId: owner.profileId, cents: 100, leadId: randomUUID() })).rejects.toThrow(/FORBIDDEN/);
      await expect(debitForPurchase(tx, owner.viewer, { userId: owner.profileId, cents: 0, leadId: randomUUID() })).rejects.toThrow(/positive/);
      // The system (allocation) may debit on the buyer's behalf.
      await expect(debitForPurchase(tx, SYSTEM, { userId: owner.profileId, cents: 100, leadId: randomUUID() })).resolves.toMatchObject({ balanceCents: 4900 });
    });
  });
});

describe("refundToCredit", () => {
  it("credits the refund once per refund id, and only for an admin", async () => {
    await withTestDb(async (tx) => {
      const { viewer, profileId } = await makeAccount(tx);
      await topUp(tx, profileId, 5000);
      const leadId = randomUUID();
      await debitForPurchase(tx, viewer, { userId: profileId, cents: 2500, leadId });
      const refundId = randomUUID();
      await expect(refundToCredit(tx, viewer, { userId: profileId, cents: 2500, leadId, refundId })).rejects.toThrow(/FORBIDDEN/);

      const first = await refundToCredit(tx, SYSTEM, { userId: profileId, cents: 2500, leadId, refundId });
      expect(first).toMatchObject({ balanceCents: 5000, alreadyRefunded: false });
      const again = await refundToCredit(tx, SYSTEM, { userId: profileId, cents: 2500, leadId, refundId });
      expect(again).toMatchObject({ entryId: first.entryId, balanceCents: 5000, alreadyRefunded: true });

      const rows = await tx.select().from(creditLedger).where(and(eq(creditLedger.userId, profileId), eq(creditLedger.kind, "refund")));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ deltaCents: 2500, refType: "lead_refund", refId: refundId });
    });
  });
});

describe("adminAdjust", () => {
  it("adds or removes credit with a note, on the audit log as credit.adjusted", async () => {
    await withTestDb(async (tx) => {
      const admin = await makeAccount(tx, "admin");
      const { profileId } = await makeAccount(tx);
      expect(await adminAdjust(tx, admin.viewer, { userId: profileId, cents: 3000, note: "Goodwill" }))
        .toEqual({ outcome: "adjusted", balanceCents: 3000 });
      expect(await adminAdjust(tx, admin.viewer, { userId: profileId, cents: -1000, note: "Correction" }))
        .toEqual({ outcome: "adjusted", balanceCents: 2000 });

      const [entry] = await tx.select().from(creditLedger).where(and(eq(creditLedger.userId, profileId), eq(creditLedger.deltaCents, -1000)));
      expect(entry).toMatchObject({ kind: "adjust", note: "Correction", createdBy: admin.profileId });
      const audits = await tx.select().from(auditLog).where(eq(auditLog.entityId, profileId));
      expect(audits.map((a) => a.action)).toEqual(["credit.adjusted", "credit.adjusted"]);
      expect(audits.every((a) => a.actorId === admin.profileId)).toBe(true);
    });
  });

  it("refuses a missing note, a zero or fractional amount, a balance taken below zero, an unknown account and a non-admin", async () => {
    await withTestDb(async (tx) => {
      const admin = await makeAccount(tx, "admin");
      const { viewer, profileId } = await makeAccount(tx);
      await topUp(tx, profileId, 1000);
      expect(await adminAdjust(tx, admin.viewer, { userId: profileId, cents: 500, note: "  " })).toEqual({ outcome: "note-required" });
      expect(await adminAdjust(tx, admin.viewer, { userId: profileId, cents: 0, note: "x" })).toEqual({ outcome: "invalid-amount" });
      expect(await adminAdjust(tx, admin.viewer, { userId: profileId, cents: 1.5, note: "x" })).toEqual({ outcome: "invalid-amount" });
      expect(await adminAdjust(tx, admin.viewer, { userId: profileId, cents: -1001, note: "x" })).toEqual({ outcome: "would-go-negative", balanceCents: 1000 });
      expect(await adminAdjust(tx, admin.viewer, { userId: randomUUID(), cents: 100, note: "x" })).toEqual({ outcome: "unknown-account" });
      await expect(adminAdjust(tx, viewer, { userId: profileId, cents: 100, note: "x" })).rejects.toThrow(/FORBIDDEN/);
      expect(await creditBalance(tx, profileId)).toBe(1000);
    });
  });
});

describe("creditLedgerFor and creditBalances", () => {
  it("shows an account its own entries newest first, and the admin every balance", async () => {
    await withTestDb(async (tx) => {
      const admin = await makeAccount(tx, "admin");
      const a = await makeAccount(tx);
      const b = await makeAccount(tx);
      await topUp(tx, a.profileId, 5000);
      await debitForPurchase(tx, a.viewer, { userId: a.profileId, cents: 2500, leadId: randomUUID() });

      const mine = await creditLedgerFor(tx, a.viewer, a.profileId);
      expect(mine.map((r) => r.deltaCents).sort()).toEqual([-2500, 5000]);
      await expect(creditLedgerFor(tx, b.viewer, a.profileId)).rejects.toThrow(/FORBIDDEN/);

      const all = await creditBalances(tx, admin.viewer);
      const row = all.find((r) => r.profileId === a.profileId);
      expect(row).toMatchObject({ balanceCents: 2500, email: expect.stringContaining("@example.com") });
      expect(all.find((r) => r.profileId === b.profileId)).toBeUndefined();
      await expect(creditBalances(tx, a.viewer)).rejects.toThrow(/FORBIDDEN/);
    });
  });
});

describe("profileIdByEmail", () => {
  it("finds an account's profile by email, case-insensitively, for an admin only", async () => {
    await withTestDb(async (tx) => {
      const admin = await makeAccount(tx, "admin");
      const a = await makeAccount(tx);
      const [u] = await tx.select({ email: user.email }).from(user).innerJoin(profiles, eq(profiles.userId, user.id)).where(eq(profiles.id, a.profileId));
      expect(await profileIdByEmail(tx, admin.viewer, ` ${u!.email.toUpperCase()} `)).toBe(a.profileId);
      expect(await profileIdByEmail(tx, admin.viewer, "nobody@example.com")).toBeNull();
      await expect(profileIdByEmail(tx, a.viewer, u!.email)).rejects.toThrow(/FORBIDDEN/);
    });
  });
});

/**
 * Two transactions in flight at once against COMMITTED rows: the only way the
 * advisory lock is tested at all. `withTestDb` gives one throwaway
 * transaction, so this opens its own connections and cleans up after itself.
 */
describe("debitForPurchase concurrency", () => {
  const url = process.env.TEST_DATABASE_URL ?? "postgres://directory:directory@localhost:5433/directory_test";
  const client = postgres(url, { max: 4, onnotice: () => {} });
  const database = drizzle(client, { schema });
  const userId = `u_race_${randomUUID()}`;

  afterAll(async () => {
    // Cascades to the profile and its ledger rows.
    await database.delete(user).where(eq(user.id, userId));
    await client.end({ timeout: 5 });
  });

  it("lets exactly one of two simultaneous debits through when the balance covers only one", async () => {
    await database.insert(user).values({ id: userId, name: "Race", email: `${userId}@example.com` });
    const [p] = await database.insert(profiles).values({ userId }).returning({ id: profiles.id });
    const profileId = p!.id;
    await postLedger(database as unknown as TestDb, SYSTEM, { userId: profileId, deltaCents: 5000, kind: "topup" });

    const attempt = () =>
      database.transaction(async (tx) => {
        const out = await debitForPurchase(tx as unknown as TestDb, SYSTEM, { userId: profileId, cents: 4000, leadId: randomUUID() });
        // Hold the lock a moment so the two genuinely overlap.
        await new Promise((r) => setTimeout(r, 100));
        return out;
      });

    const results = await Promise.allSettled([attempt(), attempt()]);
    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r) => r.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect((lost[0] as PromiseRejectedResult).reason).toBeInstanceOf(InsufficientCredit);
    expect(await creditBalance(database as unknown as TestDb, profileId)).toBe(1000);
  });
});
