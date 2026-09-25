import { and, desc, eq, sql } from "drizzle-orm";
import { creditLedger, profiles, user } from "@/lib/db/schema";
import { ensureProfile } from "@/lib/auth/profile";
import { isAdmin, type Viewer } from "@/lib/db/viewer";
import type { TestDb } from "@/lib/db/types";
import { writeAudit } from "@/lib/db/queries/audit";

/**
 * The prepaid lead-credit ledger (Task 57, flag `leadMarketplace`).
 *
 * Append-only. A balance is the sum of the user's rows and nothing else, so
 * every figure an account is shown can be explained line by line. Amounts are
 * minor units of `siteConfig.currency`; `userId` everywhere here is
 * `profiles.id` (constraint 21), never Better Auth's text id.
 *
 * Spending is the dangerous direction. `debitForPurchase` and
 * `refundToCredit` take `pg_advisory_xact_lock(hashtext(user_id))` before they
 * read the balance: two purchases racing on one balance serialise on the
 * lock, the second reads the first's committed debit, and only one of them
 * can spend money that is there once. The lock is released with the
 * transaction, so it covers exactly the caller's write.
 */

export type CreditKind = (typeof creditLedger.$inferInsert)["kind"];

/** Thrown by `debitForPurchase` when the balance does not cover the price. Nothing is written. */
export class InsufficientCredit extends Error {
  constructor(
    readonly balanceCents: number,
    readonly neededCents: number,
  ) {
    super(`Insufficient credit: balance ${balanceCents}, needed ${neededCents}`);
    this.name = "InsufficientCredit";
  }
}

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

function assertAdmin(viewer: Viewer): void {
  if (!isAdmin(viewer)) throw new Error("FORBIDDEN");
}

/** An admin (or the system) acts for anyone; a signed-in user only for their own profile. */
async function assertActsFor(tx: TestDb, viewer: Viewer, userId: string): Promise<void> {
  if (isAdmin(viewer)) return;
  if (viewer.role === "public") throw new Error("FORBIDDEN");
  const profile = await ensureProfile(tx, viewer);
  if (profile.id !== userId) throw new Error("FORBIDDEN");
}

/** Serialises every spend and refund on one user's balance until the transaction ends. */
async function lockBalance(tx: TestDb, userId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${userId}))`);
}

/** The user's balance in minor units: the sum of their ledger. */
export async function creditBalance(tx: TestDb, userId: string): Promise<number> {
  const [row] = await tx
    .select({ total: sql<string>`coalesce(sum(${creditLedger.deltaCents}), 0)` })
    .from(creditLedger)
    .where(eq(creditLedger.userId, userId));
  return Number(row?.total ?? 0);
}

export interface LedgerEntry {
  readonly userId: string;
  readonly deltaCents: number;
  readonly kind: CreditKind;
  readonly refType?: string | null;
  readonly refId?: string | null;
  readonly note?: string | null;
  /** A top-up's PayPal order. Unique: a second entry for the same order is refused. */
  readonly orderId?: string | null;
  readonly createdBy?: string | null;
}

/**
 * The one insert every entry goes through. System-only: a user never writes
 * their own ledger directly. Returns the new row's id, or null when an entry
 * for the same `orderId` already exists — the idempotency the top-up paths
 * rely on.
 */
export async function postLedger(tx: TestDb, viewer: Viewer, entry: LedgerEntry): Promise<string | null> {
  assertAdmin(viewer);
  const rows = await tx
    .insert(creditLedger)
    .values({
      userId: entry.userId,
      deltaCents: entry.deltaCents,
      kind: entry.kind,
      refType: entry.refType ?? null,
      refId: entry.refId ?? null,
      note: entry.note ?? null,
      orderId: entry.orderId ?? null,
      createdBy: entry.createdBy ?? null,
    })
    .onConflictDoNothing({ target: creditLedger.orderId })
    .returning({ id: creditLedger.id });
  return rows[0]?.id ?? null;
}

function assertPositiveCents(cents: number): void {
  if (!Number.isInteger(cents) || cents <= 0) throw new Error(`Amount must be a positive whole number of cents, got ${cents}`);
}

/**
 * Spends `cents` of the user's credit on a lead. Atomic: under the user's
 * advisory lock the balance is read and, only if it covers the price, the
 * debit is written. Short → `InsufficientCredit` and nothing written.
 */
export async function debitForPurchase(
  tx: TestDb,
  viewer: Viewer,
  input: { userId: string; cents: number; leadId: string },
): Promise<{ entryId: string; balanceCents: number }> {
  await assertActsFor(tx, viewer, input.userId);
  assertPositiveCents(input.cents);
  await lockBalance(tx, input.userId);
  const balance = await creditBalance(tx, input.userId);
  if (balance < input.cents) throw new InsufficientCredit(balance, input.cents);
  const [row] = await tx
    .insert(creditLedger)
    .values({ userId: input.userId, deltaCents: -input.cents, kind: "purchase", refType: "lead", refId: input.leadId })
    .returning({ id: creditLedger.id });
  return { entryId: row!.id, balanceCents: balance - input.cents };
}

/**
 * Credits a refunded lead back. Admin-only (the refund queue decides) and
 * idempotent per `refundId`: a second approval of the same refund returns the
 * first entry rather than paying twice.
 */
export async function refundToCredit(
  tx: TestDb,
  viewer: Viewer,
  input: { userId: string; cents: number; leadId: string; refundId: string },
): Promise<{ entryId: string; balanceCents: number; alreadyRefunded: boolean }> {
  assertAdmin(viewer);
  assertPositiveCents(input.cents);
  await lockBalance(tx, input.userId);
  const [existing] = await tx
    .select({ id: creditLedger.id })
    .from(creditLedger)
    .where(and(eq(creditLedger.refType, "lead_refund"), eq(creditLedger.refId, input.refundId)))
    .limit(1);
  if (existing) {
    return { entryId: existing.id, balanceCents: await creditBalance(tx, input.userId), alreadyRefunded: true };
  }
  const [row] = await tx
    .insert(creditLedger)
    .values({
      userId: input.userId,
      deltaCents: input.cents,
      kind: "refund",
      refType: "lead_refund",
      refId: input.refundId,
      note: `Refund for lead ${input.leadId}`,
    })
    .returning({ id: creditLedger.id });
  return { entryId: row!.id, balanceCents: await creditBalance(tx, input.userId), alreadyRefunded: false };
}

export type AdjustResult =
  | { outcome: "adjusted"; balanceCents: number }
  | { outcome: "note-required" }
  | { outcome: "invalid-amount" }
  | { outcome: "would-go-negative"; balanceCents: number }
  | { outcome: "unknown-account" };

/**
 * An admin's manual correction, positive or negative, always with a reason.
 * Credit is never cashed out except through here. Audited as
 * `credit.adjusted` in the same transaction (constraint 22).
 */
export async function adminAdjust(
  tx: TestDb,
  viewer: Viewer,
  input: { userId: string; cents: number; note: string; ip?: string | null },
): Promise<AdjustResult> {
  assertAdmin(viewer);
  const note = input.note.trim();
  if (note === "") return { outcome: "note-required" };
  if (!Number.isInteger(input.cents) || input.cents === 0) return { outcome: "invalid-amount" };

  const [account] = await tx.select({ id: profiles.id }).from(profiles).where(eq(profiles.id, input.userId)).limit(1);
  if (!account) return { outcome: "unknown-account" };

  await lockBalance(tx, input.userId);
  const before = await creditBalance(tx, input.userId);
  if (before + input.cents < 0) return { outcome: "would-go-negative", balanceCents: before };

  const actorId = viewer.role === "admin" && viewer.userId !== NIL_UUID ? (await ensureProfile(tx, viewer)).id : null;
  await tx.insert(creditLedger).values({
    userId: input.userId,
    deltaCents: input.cents,
    kind: "adjust",
    note,
    createdBy: actorId,
  });
  const after = before + input.cents;
  await writeAudit(tx, viewer, {
    action: "credit.adjusted",
    entityType: "profile",
    entityId: input.userId,
    meta: { cents: input.cents, note, balanceBefore: before, balanceAfter: after },
    ip: input.ip ?? null,
  });
  return { outcome: "adjusted", balanceCents: after };
}

export interface LedgerRow {
  readonly id: string;
  readonly createdAt: Date;
  readonly deltaCents: number;
  readonly kind: CreditKind;
  readonly note: string | null;
}

/** An account's own ledger, newest first. The owner or an admin. */
export async function creditLedgerFor(tx: TestDb, viewer: Viewer, userId: string, limit = 50): Promise<LedgerRow[]> {
  await assertActsFor(tx, viewer, userId);
  return tx
    .select({
      id: creditLedger.id,
      createdAt: creditLedger.createdAt,
      deltaCents: creditLedger.deltaCents,
      kind: creditLedger.kind,
      note: creditLedger.note,
    })
    .from(creditLedger)
    .where(eq(creditLedger.userId, userId))
    .orderBy(desc(creditLedger.createdAt), desc(creditLedger.id))
    .limit(limit);
}

export interface AccountBalance {
  readonly profileId: string;
  readonly name: string | null;
  readonly email: string | null;
  readonly balanceCents: number;
  readonly lastEntryAt: Date;
}

/** Every account that has ever held credit, largest balance first. Admin-only. */
export async function creditBalances(tx: TestDb, viewer: Viewer): Promise<AccountBalance[]> {
  assertAdmin(viewer);
  const rows = await tx
    .select({
      profileId: creditLedger.userId,
      name: user.name,
      email: user.email,
      balance: sql<string>`sum(${creditLedger.deltaCents})`,
      lastEntryAt: sql<Date>`max(${creditLedger.createdAt})`.mapWith((v: string | Date) => new Date(v)),
    })
    .from(creditLedger)
    .innerJoin(profiles, eq(profiles.id, creditLedger.userId))
    .leftJoin(user, eq(user.id, profiles.userId))
    .groupBy(creditLedger.userId, user.name, user.email)
    .orderBy(desc(sql`sum(${creditLedger.deltaCents})`))
    .limit(500);
  return rows.map((r) => ({ profileId: r.profileId, name: r.name, email: r.email, balanceCents: Number(r.balance), lastEntryAt: r.lastEntryAt }));
}
