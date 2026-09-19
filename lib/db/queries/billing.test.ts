import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { auditLog, listings, subscriptions, user, verificationChecks } from "@/lib/db/schema";
import { withTestDb, type TestDb } from "@/test/db";
import { makeListing, makeScaffold } from "@/test/factories";
import { ensureProfile } from "@/lib/auth/profile";
import { resetClock, setClock } from "@/lib/clock";
import { decide, parseEvent, type CurrentSubscription } from "@/lib/billing/webhooks";
import * as fx from "@/lib/billing/__fixtures__/paypal";
import {
  applyEffect,
  createPendingSubscription,
  dueRenewalReminders,
  invoiceHistory,
  listingForCheckout,
  markReminderSent,
  ownerCheckoutListings,
  ownerSubscriptions,
  recordProcessedEvent,
  reminderContext,
  requestCancellation,
  staleSubscriptionsForSync,
  subscriptionForEvent,
  subscriptionForOwner,
  subscriptionForOwnerByProviderId,
} from "./billing";
import { listingPaths } from "./paths";

const ADMIN = { role: "admin" as const, userId: "worker" };

afterEach(() => resetClock());

async function makeOwner(tx: TestDb): Promise<{ viewer: { role: "user"; userId: string }; profileId: string }> {
  const userId = `u_${randomUUID()}`;
  await tx.insert(user).values({ id: userId, name: "Owner", email: `${userId}@example.test` });
  const viewer = { role: "user" as const, userId };
  const { id } = await ensureProfile(tx, viewer);
  return { viewer, profileId: id };
}

async function scenario(tx: TestDb, patch: Partial<typeof listings.$inferInsert> = {}) {
  const ctx = await makeScaffold(tx);
  const owner = await makeOwner(tx);
  const listingId = await makeListing(tx, ctx, {
    ownerId: owner.profileId,
    claimStatus: "claimed",
    ...patch,
  });
  return { ...owner, listingId, ctx };
}

describe("listingForCheckout", () => {
  it("returns the listing to the profile that owns it", async () => {
    await withTestDb(async (tx) => {
      const s = await scenario(tx);
      const found = await listingForCheckout(tx, s.viewer, {
        listingId: s.listingId,
        profileId: s.profileId,
      });
      expect(found?.id).toBe(s.listingId);
      expect(found?.path).toMatch(/^\/[^/]+\/[^/]+$/);
    });
  });

  it("refuses somebody else's listing", async () => {
    await withTestDb(async (tx) => {
      const s = await scenario(tx);
      const stranger = await makeOwner(tx);
      const found = await listingForCheckout(tx, stranger.viewer, {
        listingId: s.listingId,
        profileId: stranger.profileId,
      });
      expect(found).toBeNull();
    });
  });

  it("refuses an unclaimed listing even to the profile named as owner", async () => {
    await withTestDb(async (tx) => {
      const s = await scenario(tx, { claimStatus: "unclaimed" });
      const found = await listingForCheckout(tx, s.viewer, {
        listingId: s.listingId,
        profileId: s.profileId,
      });
      expect(found).toBeNull();
    });
  });

  it("shrugs off a malformed id rather than letting Postgres throw", async () => {
    await withTestDb(async (tx) => {
      const s = await scenario(tx);
      await expect(
        listingForCheckout(tx, s.viewer, { listingId: "not-a-uuid", profileId: s.profileId }),
      ).resolves.toBeNull();
    });
  });
});

describe("ownerCheckoutListings", () => {
  it("lists only the viewer's own claimed listings, published or not", async () => {
    await withTestDb(async (tx) => {
      const s = await scenario(tx);
      const draft = await makeListing(tx, s.ctx, {
        ownerId: s.profileId,
        claimStatus: "verified",
        status: "draft",
      });
      // Named as owner but the claim has not been granted: not buyable.
      await makeListing(tx, s.ctx, { ownerId: s.profileId, claimStatus: "unclaimed" });
      // Somebody else's.
      const stranger = await makeOwner(tx);
      const theirs = await makeListing(tx, s.ctx, {
        ownerId: stranger.profileId,
        claimStatus: "claimed",
      });

      const mine = await ownerCheckoutListings(tx, s.viewer, s.profileId);
      expect(mine.map((l) => l.id).sort()).toEqual([s.listingId, draft].sort());
      expect(mine[0]!.path).toMatch(/^\/[^/]+\/[^/]+$/);

      // The profile id is the scope, and the page derives it from the viewer.
      expect((await ownerCheckoutListings(tx, stranger.viewer, stranger.profileId)).map((l) => l.id))
        .toEqual([theirs]);
      expect(await ownerCheckoutListings(tx, s.viewer, "not-a-uuid")).toEqual([]);
      await expect(ownerCheckoutListings(tx, { role: "public" }, s.profileId)).rejects.toThrow(
        "FORBIDDEN",
      );
    });
  });
});

describe("createPendingSubscription", () => {
  it("writes an approval_pending row and an audit trail", async () => {
    await withTestDb(async (tx) => {
      const s = await scenario(tx);
      const id = await createPendingSubscription(tx, s.viewer, {
        listingId: s.listingId,
        profileId: s.profileId,
        tier: "premium",
        interval: "annual",
        providerPlanId: fx.PLAN_ID,
        ip: "203.0.113.9",
      });

      const [row] = await tx.select().from(subscriptions).where(eq(subscriptions.id, id));
      expect(row).toMatchObject({
        status: "approval_pending",
        tier: "premium",
        interval: "annual",
        provider: "paypal",
      });

      const audits = await tx.select().from(auditLog).where(eq(auditLog.entityId, id));
      expect(audits).toHaveLength(1);
      expect(audits[0]!.actorId).toBe(s.profileId);
    });
  });

  it("does not touch the listing's tier — nothing is paid for yet", async () => {
    await withTestDb(async (tx) => {
      const s = await scenario(tx);
      await createPendingSubscription(tx, s.viewer, {
        listingId: s.listingId,
        profileId: s.profileId,
        tier: "premium",
        interval: "annual",
        providerPlanId: fx.PLAN_ID,
        ip: null,
      });
      const [listing] = await tx.select().from(listings).where(eq(listings.id, s.listingId));
      expect(listing!.tier).toBe("free");
    });
  });
});

describe("recordProcessedEvent", () => {
  it("is the idempotency mechanism: the second sighting returns false", async () => {
    await withTestDb(async (tx) => {
      const payload = fx.activated();
      expect(await recordProcessedEvent(tx, ADMIN, { eventId: payload.id, payload })).toBe(true);
      expect(await recordProcessedEvent(tx, ADMIN, { eventId: payload.id, payload })).toBe(false);
    });
  });

  it("refuses a viewer that is not the worker", async () => {
    await withTestDb(async (tx) => {
      await expect(
        recordProcessedEvent(tx, { role: "public" }, { eventId: "x", payload: {} }),
      ).rejects.toThrow("FORBIDDEN");
    });
  });
});

async function activated(tx: TestDb, s: Awaited<ReturnType<typeof scenario>>) {
  const id = await createPendingSubscription(tx, s.viewer, {
    listingId: s.listingId,
    profileId: s.profileId,
    tier: "premium",
    interval: "annual",
    providerPlanId: fx.PLAN_ID,
    ip: null,
  });
  await tx
    .update(subscriptions)
    .set({ providerSubscriptionId: fx.SUB_ID })
    .where(eq(subscriptions.id, id));
  return id;
}

const ENV = { PAYPAL_PLAN_PREMIUM_ANNUAL: fx.PLAN_ID };

async function apply(tx: TestDb, payload: unknown, at: Date) {
  setClock(at);
  const event = parseEvent(payload)!;
  const sub = await subscriptionForEvent(tx, ADMIN, {
    providerSubscriptionId: fx.SUB_ID,
    customId: null,
  });
  const effect = decide(event, sub as CurrentSubscription, { env: ENV, at });
  if (effect.action === "ignore") throw new Error("unexpected ignore");
  return applyEffect(tx, ADMIN, sub!, effect, { eventId: event.id });
}

describe("applyEffect", () => {
  it("activation sets the listing's tier and opens a verification check, but never verifies", async () => {
    await withTestDb(async (tx) => {
      const s = await scenario(tx);
      const id = await activated(tx, s);
      const out = await apply(tx, fx.activated(), new Date("2026-09-12T09:00:10Z"));

      const [sub] = await tx.select().from(subscriptions).where(eq(subscriptions.id, id));
      expect(sub!.status).toBe("active");
      expect(sub!.currentPeriodEnd?.toISOString()).toBe("2026-10-12T09:00:00.000Z");

      const [listing] = await tx.select().from(listings).where(eq(listings.id, s.listingId));
      expect(listing!.tier).toBe("premium");
      // Global constraint 30: paying never grants the badge.
      expect(listing!.claimStatus).toBe("claimed");

      const checks = await tx
        .select()
        .from(verificationChecks)
        .where(eq(verificationChecks.listingId, s.listingId));
      expect(checks).toHaveLength(1);
      expect(checks[0]!.status).toBe("open");

      // Everything a tier change moves: the listing page, its reviews page,
      // the city pillar (featured row and sort), every paginated page of it,
      // and the category pillar — the same list the worker's sync busts.
      expect(out.paths).toEqual(await listingPaths(tx, ADMIN, s.listingId));
      expect(out.paths.length).toBeGreaterThanOrEqual(3);
    });
  });

  it("opens only one verification check however many activations arrive", async () => {
    await withTestDb(async (tx) => {
      const s = await scenario(tx);
      await activated(tx, s);
      await apply(tx, fx.activated(), new Date("2026-09-12T09:00:10Z"));
      await apply(tx, fx.activated(), new Date("2026-09-12T09:05:00Z"));
      const checks = await tx
        .select()
        .from(verificationChecks)
        .where(eq(verificationChecks.listingId, s.listingId));
      expect(checks).toHaveLength(1);
    });
  });

  it("a lapse drops verified back to claimed and the tier back to free", async () => {
    await withTestDb(async (tx) => {
      const s = await scenario(tx);
      await activated(tx, s);
      await apply(tx, fx.activated(), new Date("2026-09-12T09:00:10Z"));
      // The check passed, so the badge is on.
      await tx
        .update(listings)
        .set({ claimStatus: "verified" })
        .where(eq(listings.id, s.listingId));

      await apply(tx, fx.suspended(), new Date("2026-09-20T09:00:00Z"));

      const [listing] = await tx.select().from(listings).where(eq(listings.id, s.listingId));
      expect(listing!.tier).toBe("free");
      expect(listing!.claimStatus).toBe("claimed");
    });
  });

  it("cancelling mid-period keeps the tier that was paid for", async () => {
    await withTestDb(async (tx) => {
      const s = await scenario(tx);
      const id = await activated(tx, s);
      await apply(tx, fx.activated(), new Date("2026-09-12T09:00:10Z"));
      await tx
        .update(listings)
        .set({ claimStatus: "verified" })
        .where(eq(listings.id, s.listingId));

      await apply(tx, fx.cancelled(), new Date("2026-09-20T09:00:00Z"));

      const [sub] = await tx.select().from(subscriptions).where(eq(subscriptions.id, id));
      expect(sub!.status).toBe("cancelled");
      expect(sub!.cancelAtPeriodEnd).toBe(true);

      const [listing] = await tx.select().from(listings).where(eq(listings.id, s.listingId));
      expect(listing!.tier).toBe("premium");
      expect(listing!.claimStatus).toBe("verified");
    });
  });

  it("a renewal extends the period and restores an active status", async () => {
    await withTestDb(async (tx) => {
      const s = await scenario(tx);
      const id = await activated(tx, s);
      await apply(tx, fx.activated(), new Date("2026-09-12T09:00:10Z"));
      await apply(tx, fx.saleCompleted(), new Date("2026-10-12T09:00:05Z"));

      const [sub] = await tx.select().from(subscriptions).where(eq(subscriptions.id, id));
      expect(sub!.status).toBe("active");
      expect(sub!.currentPeriodEnd?.toISOString()).toBe("2027-10-12T09:00:00.000Z");
    });
  });

  it("writes one audit row per event", async () => {
    await withTestDb(async (tx) => {
      const s = await scenario(tx);
      const id = await activated(tx, s);
      await apply(tx, fx.activated(), new Date("2026-09-12T09:00:10Z"));
      const audits = await tx.select().from(auditLog).where(eq(auditLog.entityId, id));
      // One for the pending row, one for the activation.
      expect(audits).toHaveLength(2);
    });
  });
});

describe("ownerSubscriptions", () => {
  it("shows only what the viewer's own profile owns", async () => {
    await withTestDb(async (tx) => {
      const s = await scenario(tx);
      await activated(tx, s);
      const stranger = await makeOwner(tx);

      expect(await ownerSubscriptions(tx, s.viewer, s.profileId)).toHaveLength(1);
      expect(await ownerSubscriptions(tx, stranger.viewer, stranger.profileId)).toHaveLength(0);
    });
  });

  it("refuses to read another profile's subscriptions for a plain user", async () => {
    await withTestDb(async (tx) => {
      const s = await scenario(tx);
      const stranger = await makeOwner(tx);
      await expect(ownerSubscriptions(tx, stranger.viewer, s.profileId)).resolves.toHaveLength(0);
    });
  });
});

describe("subscriptionForOwnerByProviderId", () => {
  it("resolves PayPal's id only for the profile that owns the listing", async () => {
    await withTestDb(async (tx) => {
      const s = await scenario(tx);
      const id = await activated(tx, s);

      const mine = await subscriptionForOwnerByProviderId(tx, s.viewer, {
        providerSubscriptionId: fx.SUB_ID,
        profileId: s.profileId,
      });
      expect(mine).toMatchObject({ id, listingId: s.listingId });
      expect(mine?.listingPath).toMatch(/^\/[^/]+\/[^/]+$/);

      // A stranger who has guessed or been shown the PayPal id learns
      // nothing — not even that it exists.
      const stranger = await makeOwner(tx);
      expect(
        await subscriptionForOwnerByProviderId(tx, stranger.viewer, {
          providerSubscriptionId: fx.SUB_ID,
          profileId: stranger.profileId,
        }),
      ).toBeNull();
    });
  });

  it("is null for an id nobody holds, and refuses the public", async () => {
    await withTestDb(async (tx) => {
      const s = await scenario(tx);
      expect(
        await subscriptionForOwnerByProviderId(tx, s.viewer, {
          providerSubscriptionId: "I-NOBODY",
          profileId: s.profileId,
        }),
      ).toBeNull();
      await expect(
        subscriptionForOwnerByProviderId(tx, { role: "public" }, {
          providerSubscriptionId: fx.SUB_ID,
          profileId: s.profileId,
        }),
      ).rejects.toThrow("FORBIDDEN");
    });
  });
});

describe("requestCancellation", () => {
  it("marks the row and audits it, for the owner only", async () => {
    await withTestDb(async (tx) => {
      const s = await scenario(tx);
      const id = await activated(tx, s);
      await apply(tx, fx.activated(), new Date("2026-09-12T09:00:10Z"));

      const stranger = await makeOwner(tx);
      await expect(
        requestCancellation(tx, stranger.viewer, {
          subscriptionId: id,
          profileId: stranger.profileId,
          ip: null,
        }),
      ).resolves.toBe(false);

      await expect(
        requestCancellation(tx, s.viewer, { subscriptionId: id, profileId: s.profileId, ip: null }),
      ).resolves.toBe(true);

      const [row] = await tx.select().from(subscriptions).where(eq(subscriptions.id, id));
      expect(row!.cancelAtPeriodEnd).toBe(true);
    });
  });
});

describe("subscriptionForOwner", () => {
  it("is scoped to the owning profile", async () => {
    await withTestDb(async (tx) => {
      const s = await scenario(tx);
      const id = await activated(tx, s);
      expect(await subscriptionForOwner(tx, s.viewer, { id, profileId: s.profileId })).not.toBeNull();
      const stranger = await makeOwner(tx);
      expect(
        await subscriptionForOwner(tx, stranger.viewer, { id, profileId: stranger.profileId }),
      ).toBeNull();
    });
  });
});

describe("invoiceHistory", () => {
  it("reads completed sales out of the processed events, newest first", async () => {
    await withTestDb(async (tx) => {
      const s = await scenario(tx);
      await activated(tx, s);
      const first = fx.saleCompleted();
      const second = {
        ...fx.saleCompleted(),
        id: "WH-SALE-2",
        resource: { ...fx.saleCompleted().resource, id: "SALE-2", create_time: "2028-09-12T09:00:05Z" },
      };
      await recordProcessedEvent(tx, ADMIN, { eventId: first.id, payload: first });
      await recordProcessedEvent(tx, ADMIN, { eventId: second.id, payload: second });

      const invoices = await invoiceHistory(tx, s.viewer, [fx.SUB_ID]);
      expect(invoices).toHaveLength(2);
      expect(invoices[0]!.paidAt.getTime()).toBeGreaterThan(invoices[1]!.paidAt.getTime());
      expect(invoices[0]).toMatchObject({ amount: "249.00", currency: "GBP" });
    });
  });

  it("returns nothing when the owner has no subscriptions", async () => {
    await withTestDb(async (tx) => {
      const s = await scenario(tx);
      await expect(invoiceHistory(tx, s.viewer, [])).resolves.toEqual([]);
    });
  });
});

describe("dueRenewalReminders", () => {
  it("finds active subscriptions whose period ends in exactly the offset window", async () => {
    await withTestDb(async (tx) => {
      const s = await scenario(tx);
      const id = await activated(tx, s);
      await apply(tx, fx.activated(), new Date("2026-09-12T09:00:10Z"));
      // Period ends 2026-10-12T09:00Z.
      setClock(new Date("2026-09-12T12:00:00Z"));

      const due = await dueRenewalReminders(tx, ADMIN, { offsetDays: 30 });
      expect(due.map((d) => d.subscriptionId)).toContain(id);

      const notDue = await dueRenewalReminders(tx, ADMIN, { offsetDays: 7 });
      expect(notDue.map((d) => d.subscriptionId)).not.toContain(id);
    });
  });

  it("skips a subscription that is already cancelling", async () => {
    await withTestDb(async (tx) => {
      const s = await scenario(tx);
      const id = await activated(tx, s);
      await apply(tx, fx.activated(), new Date("2026-09-12T09:00:10Z"));
      await tx.update(subscriptions).set({ cancelAtPeriodEnd: true }).where(eq(subscriptions.id, id));
      setClock(new Date("2026-09-12T12:00:00Z"));
      const due = await dueRenewalReminders(tx, ADMIN, { offsetDays: 30 });
      expect(due.map((d) => d.subscriptionId)).not.toContain(id);
    });
  });

  it("does not send the same reminder twice", async () => {
    await withTestDb(async (tx) => {
      const s = await scenario(tx);
      const id = await activated(tx, s);
      await apply(tx, fx.activated(), new Date("2026-09-12T09:00:10Z"));
      setClock(new Date("2026-09-12T12:00:00Z"));

      const due = await dueRenewalReminders(tx, ADMIN, { offsetDays: 30 });
      expect(due).toHaveLength(1);
      await markReminderSent(tx, ADMIN, due[0]!);
      expect(await dueRenewalReminders(tx, ADMIN, { offsetDays: 30 })).toHaveLength(0);
    });
  });
});

describe("reminder recipient", () => {
  it("is the payer's account email, not the listing's public address", async () => {
    await withTestDb(async (tx) => {
      // The listing's email is the enquiry inbox — info@, or whoever answered
      // the phone when it was scraped. The person about to be charged is the
      // account that bought the plan.
      const s = await scenario(tx, { email: "info@venue.example" });
      const id = await activated(tx, s);
      await apply(tx, fx.activated(), new Date("2026-09-12T09:00:10Z"));
      setClock(new Date("2026-09-12T12:00:00Z"));

      const [due] = await dueRenewalReminders(tx, ADMIN, { offsetDays: 30 });
      expect(due?.email).toBe(`${s.viewer.userId}@example.test`);
      const context = await reminderContext(tx, ADMIN, id);
      expect(context?.email).toBe(`${s.viewer.userId}@example.test`);
    });
  });

  it("falls back to the listing's address only when there is no payer email", async () => {
    await withTestDb(async (tx) => {
      const s = await scenario(tx, { email: "info@venue.example" });
      const id = await activated(tx, s);
      await apply(tx, fx.activated(), new Date("2026-09-12T09:00:10Z"));
      await tx.update(subscriptions).set({ userId: null }).where(eq(subscriptions.id, id));
      setClock(new Date("2026-09-12T12:00:00Z"));

      const [due] = await dueRenewalReminders(tx, ADMIN, { offsetDays: 30 });
      expect(due?.email).toBe("info@venue.example");
      expect((await reminderContext(tx, ADMIN, id))?.email).toBe("info@venue.example");
    });
  });
});

describe("staleSubscriptionsForSync", () => {
  it("drops a cancelled row once its listing is free, keeps it while the tier is paid", async () => {
    await withTestDb(async (tx) => {
      const s = await scenario(tx);
      const id = await activated(tx, s);
      await apply(tx, fx.activated(), new Date("2026-09-12T09:00:10Z"));
      setClock(new Date("2026-10-16T00:00:00Z"));

      // Cancelled, but the listing still carries the paid tier: the sync must
      // still see it, because the sync is what performs the lapse.
      await tx.update(subscriptions).set({ status: "cancelled" }).where(eq(subscriptions.id, id));
      expect((await staleSubscriptionsForSync(tx, ADMIN, { graceDays: 3 })).map((r) => r.id))
        .toContain(id);

      // Lapsed: nothing left to lose or restore, so it is never re-fetched.
      await tx.update(listings).set({ tier: "free" }).where(eq(listings.id, s.listingId));
      expect((await staleSubscriptionsForSync(tx, ADMIN, { graceDays: 3 })).map((r) => r.id))
        .not.toContain(id);
    });
  });

  it("finds active rows past their period end plus the grace days", async () => {
    await withTestDb(async (tx) => {
      const s = await scenario(tx);
      const id = await activated(tx, s);
      await apply(tx, fx.activated(), new Date("2026-09-12T09:00:10Z"));

      setClock(new Date("2026-10-14T00:00:00Z"));
      expect((await staleSubscriptionsForSync(tx, ADMIN, { graceDays: 3 })).map((r) => r.id))
        .not.toContain(id);

      setClock(new Date("2026-10-16T00:00:00Z"));
      expect((await staleSubscriptionsForSync(tx, ADMIN, { graceDays: 3 })).map((r) => r.id))
        .toContain(id);
    });
  });
});
