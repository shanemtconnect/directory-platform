import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/lib/db/schema";
import {
  auditLog, categories, cities, jobQueue, leadBlocklist, leadPurchases, leadRefunds, leadStandingOrders, leads, listings,
  profiles, slugs, user, verticals,
} from "@/lib/db/schema";
import { withTestDb, type TestDb } from "@/test/db";
import type { Viewer } from "@/lib/db/viewer";
import { makeCategoryInCity, makeCity, makeScaffold, makeVertical, type ListingCtx } from "@/test/factories";
import { credit, makeBuyer, makeLead, makeStandingOrder } from "@/test/leads";
import { siteConfig } from "@/config/site.config";
import { creditBalance } from "./credits";
import { checkLeadRules } from "@/lib/leads/rules";
import { NOTIFY_LEAD_REFUND_DECIDED } from "@/lib/email/notify";
import { allocateLead } from "@/lib/leads/allocate";
import {
  MAX_ORDER_CENTS, adminBuyers, adminDeleteLead, adminLeadCounts, adminRefundQueue, boardDigestFor, boardDigestRecipients,
  boardLeads, buyLead, createStandingOrder, decideRefund, deleteStandingOrder, leadWonNotification, myPurchases,
  purchasedLead, requestRefund, setLeadDigestOptOut, setStandingOrderStatus, standingOrdersFor, sweepLeads,
  updateStandingOrder,
} from "./lead-market";

const SYSTEM: Viewer = { role: "admin", userId: "00000000-0000-0000-0000-000000000000" };
const DAY = 86_400_000;
const NOW = new Date("2026-09-25T12:00:00Z");
const at = (days: number) => new Date(NOW.getTime() + days * DAY);
const FLOOR = Math.round(siteConfig.leads.floor * 100);

async function admin(tx: TestDb): Promise<Viewer> {
  const id = `u_${randomUUID()}`;
  await tx.insert(user).values({ id, name: "Admin", email: `${id}@example.com` });
  await tx.insert(profiles).values({ userId: id, role: "admin" });
  return { role: "admin", userId: id };
}

const CONTACT_KEYS = ["name", "email", "phone", "message", "phoneNormalised", "emailNormalised"];

describe("boardLeads", () => {
  it("is for signed-in viewers only", async () => {
    await withTestDb(async (tx) => {
      await expect(boardLeads(tx, { role: "public" }, { page: 1 })).rejects.toThrow(/FORBIDDEN/);
    });
  });

  it("lists open, unexpired leads with first name, town, category, brief and price — never a contact field", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const viewer = (await makeBuyer(tx, ctx)).viewer;
      const open = await makeLead(tx, ctx, {}, at(-1));
      const sold = await makeLead(tx, ctx, { status: "sold" }, at(-1));
      const lapsed = await makeLead(tx, ctx, { expiresAt: at(-0.5) }, at(-40));
      const board = await boardLeads(tx, viewer, { page: 1 }, NOW);
      const ids = board.leads.map((l) => l.id);
      expect(ids).toContain(open);
      expect(ids).not.toContain(sold);
      expect(ids).not.toContain(lapsed);
      const row = board.leads.find((l) => l.id === open)!;
      expect(row).toMatchObject({ firstName: "Sam", brief: "About eighty guests in June.", cityName: "Leeds", categoryName: "Barn Venues", priceCents: 2500, halfPrice: false });
      for (const key of CONTACT_KEYS) expect(row).not.toHaveProperty(key);
    });
  });

  it("halves the price from half_price_at", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const viewer = (await makeBuyer(tx, ctx)).viewer;
      const id = await makeLead(tx, ctx, { priceCents: 2500, halfPriceAt: at(-0.1) }, at(-8));
      const row = (await boardLeads(tx, viewer, { page: 1 }, NOW)).leads.find((l) => l.id === id)!;
      expect(row).toMatchObject({ priceCents: 1250, halfPrice: true });
    });
  });
});

describe("buyLead", () => {
  it("debits today's price, sells the lead to the listing and reveals it to the buyer only", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const buyer = await makeBuyer(tx, ctx, 5000);
      const other = await makeBuyer(tx, ctx, 5000);
      const leadId = await makeLead(tx, ctx, { halfPriceAt: at(-1) }, at(-8));

      const out = await buyLead(tx, buyer.viewer, leadId, buyer.listingId, NOW);
      expect(out.outcome).toBe("bought");
      expect(await creditBalance(tx, buyer.profileId)).toBe(5000 - 1250);
      const [lead] = await tx.select().from(leads).where(eq(leads.id, leadId));
      expect(lead).toMatchObject({ status: "sold", soldToListingId: buyer.listingId, buyerUserId: buyer.authUserId });
      const [purchase] = await tx.select().from(leadPurchases).where(eq(leadPurchases.leadId, leadId));
      expect(purchase).toMatchObject({ priceCents: 1250, standingOrderId: null, userId: buyer.profileId });

      const details = await purchasedLead(tx, buyer.viewer, leadId, NOW);
      expect(details).toMatchObject({ name: "Sam Requester", phone: expect.stringMatching(/^01632 97\d{4}$/), refundable: true });
      expect(await purchasedLead(tx, other.viewer, leadId, NOW)).toBeNull();
      expect(await purchasedLead(tx, { role: "public" }, leadId, NOW)).toBeNull();

      // The purchase list shows first name and brief, not the contact.
      const [mine] = await myPurchases(tx, buyer.viewer, NOW);
      expect(mine).toMatchObject({ leadId, firstName: "Sam", priceCents: 1250, viaStandingOrder: false, refundable: true });
      for (const key of CONTACT_KEYS) expect(mine).not.toHaveProperty(key);
    });
  });

  it("with too little credit returns the shortfall and writes nothing", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const buyer = await makeBuyer(tx, ctx, 1000);
      const leadId = await makeLead(tx, ctx);
      expect(await buyLead(tx, buyer.viewer, leadId, buyer.listingId)).toEqual({ outcome: "insufficient", balanceCents: 1000, neededCents: 2500 });
      expect(await creditBalance(tx, buyer.profileId)).toBe(1000);
      const [lead] = await tx.select().from(leads).where(eq(leads.id, leadId));
      expect(lead!.status).toBe("open");
      expect(await tx.select().from(leadPurchases).where(eq(leadPurchases.leadId, leadId))).toHaveLength(0);
    });
  });

  it("refuses a listing the viewer does not own, and a lead that has gone", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const buyer = await makeBuyer(tx, ctx, 10_000);
      const other = await makeBuyer(tx, ctx, 10_000);
      const leadId = await makeLead(tx, ctx);
      expect(await buyLead(tx, buyer.viewer, leadId, other.listingId)).toEqual({ outcome: "not-your-listing" });
      expect((await buyLead(tx, other.viewer, leadId, other.listingId)).outcome).toBe("bought");
      expect(await buyLead(tx, buyer.viewer, leadId, buyer.listingId)).toEqual({ outcome: "gone" });
      expect(await creditBalance(tx, buyer.profileId)).toBe(10_000);
      await expect(buyLead(tx, { role: "public" }, leadId, buyer.listingId)).rejects.toThrow(/FORBIDDEN/);
    });
  });
});

describe("refunds", () => {
  async function bought(tx: TestDb, ctx: ListingCtx) {
    const buyer = await makeBuyer(tx, ctx, 5000);
    const leadId = await makeLead(tx, ctx, {}, NOW);
    await buyLead(tx, buyer.viewer, leadId, buyer.listingId, NOW);
    return { buyer, leadId };
  }

  it("may be requested once, within the window, for a D10 reason, by the buyer only", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const { buyer, leadId } = await bought(tx, ctx);
      const stranger = await makeBuyer(tx, ctx);
      expect(await requestRefund(tx, buyer.viewer, { leadId, reason: "changed_mind", note: "" }, at(1))).toEqual({ outcome: "invalid-reason" });
      expect(await requestRefund(tx, stranger.viewer, { leadId, reason: "dead_phone", note: "" }, at(1))).toEqual({ outcome: "not-found" });
      expect(await requestRefund(tx, buyer.viewer, { leadId, reason: "dead_phone", note: "" }, at(siteConfig.leads.refundWindowDays))).toEqual({ outcome: "window-closed" });
      const ok = await requestRefund(tx, buyer.viewer, { leadId, reason: "dead_phone", note: "Number unobtainable twice." }, at(1));
      expect(ok.outcome).toBe("requested");
      expect(await requestRefund(tx, buyer.viewer, { leadId, reason: "spam", note: "" }, at(1))).toEqual({ outcome: "already-reported" });
      expect((await purchasedLead(tx, buyer.viewer, leadId, at(1)))?.refund).toMatchObject({ status: "pending", reason: "dead_phone" });
    });
  });

  it("approval credits the price back, blocklists phone and email for 12 months, audits, emails, and leaves the lead sold", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const { buyer, leadId } = await bought(tx, ctx);
      const req = await requestRefund(tx, buyer.viewer, { leadId, reason: "never_asked", note: "" }, at(1));
      const refundId = (req as { refundId: string }).refundId;
      const staff = await admin(tx);

      await expect(decideRefund(tx, buyer.viewer, refundId, { approve: true, note: "" })).rejects.toThrow(/FORBIDDEN/);
      const out = await decideRefund(tx, staff, refundId, { approve: true, note: "" }, at(2));
      expect(out).toEqual({ outcome: "approved", balanceCents: 5000 });
      expect(await creditBalance(tx, buyer.profileId)).toBe(5000);
      expect(await decideRefund(tx, staff, refundId, { approve: true, note: "" }, at(2))).toEqual({ outcome: "already-decided" });
      expect(await creditBalance(tx, buyer.profileId)).toBe(5000);

      const [lead] = await tx.select().from(leads).where(eq(leads.id, leadId));
      expect(lead!.status).toBe("sold");
      const blocked = await tx.select().from(leadBlocklist).where(eq(leadBlocklist.leadId, leadId));
      expect(blocked.map((b) => b.kind).sort()).toEqual(["email", "phone"]);
      for (const b of blocked) {
        const months = (b.expiresAt!.getTime() - at(2).getTime()) / DAY;
        expect(months).toBeGreaterThanOrEqual(365);
        expect(months).toBeLessThanOrEqual(366);
      }
      // The next request from that phone is refused.
      expect(await checkLeadRules(tx, { email: "someone-else@example.co.uk", phone: lead!.phone, country: "GB" })).toEqual({ reason: "blocklisted" });

      const [audit] = await tx.select().from(auditLog).where(and(eq(auditLog.action, "lead.refund_approved"), eq(auditLog.entityId, leadId)));
      expect(audit?.meta).toMatchObject({ refundId, cents: 2500, reason: "never_asked" });
      const jobs = await tx.select().from(jobQueue).where(and(eq(jobQueue.kind, NOTIFY_LEAD_REFUND_DECIDED), sql`${jobQueue.payload}->>'refundId' = ${refundId}`));
      expect(jobs).toHaveLength(1);
      expect((await purchasedLead(tx, buyer.viewer, leadId, at(2)))?.refund).toMatchObject({ status: "approved" });
    });
  });

  it("rejection needs a note, pays nothing and blocks nothing", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const { buyer, leadId } = await bought(tx, ctx);
      const req = await requestRefund(tx, buyer.viewer, { leadId, reason: "wrong_area", note: "" }, at(1));
      const refundId = (req as { refundId: string }).refundId;
      const staff = await admin(tx);
      expect(await decideRefund(tx, staff, refundId, { approve: false, note: " " })).toEqual({ outcome: "note-required" });
      expect(await decideRefund(tx, staff, refundId, { approve: false, note: "The job is in the town listed." })).toEqual({ outcome: "rejected" });
      expect(await creditBalance(tx, buyer.profileId)).toBe(2500);
      expect(await tx.select().from(leadBlocklist).where(eq(leadBlocklist.leadId, leadId))).toHaveLength(0);
    });
  });

  it("a refund on a standing-order purchase re-opens nothing", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const buyer = await makeBuyer(tx, ctx, 10_000);
      await makeStandingOrder(tx, buyer);
      const leadId = await makeLead(tx, ctx, {}, NOW);
      expect((await allocateLead(tx, SYSTEM, leadId, NOW)).outcome).toBe("sold");
      const req = await requestRefund(tx, buyer.viewer, { leadId, reason: "bounced", note: "" }, at(1));
      await decideRefund(tx, await admin(tx), (req as { refundId: string }).refundId, { approve: true, note: "" }, at(2));
      const [lead] = await tx.select().from(leads).where(eq(leads.id, leadId));
      expect(lead!.status).toBe("sold");
      expect(await creditBalance(tx, buyer.profileId)).toBe(10_000);
    });
  });

  it("shows each buyer's refund rate, flagged above a third", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const buyer = await makeBuyer(tx, ctx, 10_000);
      const a = await makeLead(tx, ctx, {}, NOW);
      const b = await makeLead(tx, ctx, {}, NOW);
      await buyLead(tx, buyer.viewer, a, buyer.listingId, NOW);
      await buyLead(tx, buyer.viewer, b, buyer.listingId, NOW);
      await requestRefund(tx, buyer.viewer, { leadId: a, reason: "spam", note: "" }, at(1));
      const staff = await admin(tx);

      const [row] = (await adminRefundQueue(tx, staff)).filter((r) => r.leadId === a);
      expect(row?.buyer).toMatchObject({ purchases: 2, refundRequests: 1, flagged: true });
      for (const key of ["phone", "email", "message"]) expect(row).not.toHaveProperty(key);
      const listed = (await adminBuyers(tx, staff)).find((r) => r.profileId === buyer.profileId);
      expect(listed).toMatchObject({ purchases: 2, refundRequests: 1, flagged: true });
      expect((await adminLeadCounts(tx, staff)).pendingRefunds).toBeGreaterThanOrEqual(1);
      await expect(adminRefundQueue(tx, buyer.viewer)).rejects.toThrow(/FORBIDDEN/);
    });
  });
});

describe("standing orders", () => {
  it("are created on the viewer's own listing, at or above the floor, in places and categories the site has", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const buyer = await makeBuyer(tx, ctx);
      const other = await makeBuyer(tx, ctx);
      const base = { listingId: buyer.listingId, territories: [{ kind: "city" as const, id: ctx.cityId }], categoryIds: null, priceCents: FLOOR };

      expect(await createStandingOrder(tx, buyer.viewer, { ...base, listingId: other.listingId })).toMatchObject({ outcome: "invalid", errors: { listing: expect.any(String) } });
      expect(await createStandingOrder(tx, buyer.viewer, { ...base, priceCents: FLOOR - 1 })).toMatchObject({ outcome: "invalid", errors: { price: expect.any(String) } });
      expect(await createStandingOrder(tx, buyer.viewer, { ...base, priceCents: MAX_ORDER_CENTS + 1 })).toMatchObject({ outcome: "invalid", errors: { price: expect.any(String) } });
      expect(await createStandingOrder(tx, buyer.viewer, { ...base, territories: [] })).toMatchObject({ outcome: "invalid", errors: { territories: expect.any(String) } });
      expect(await createStandingOrder(tx, buyer.viewer, { ...base, territories: [{ kind: "city", id: randomUUID() }] })).toMatchObject({ outcome: "invalid", errors: { territories: expect.any(String) } });
      expect(await createStandingOrder(tx, buyer.viewer, { ...base, territories: [{ kind: "region", id: "atlantis" }] })).toMatchObject({ outcome: "invalid", errors: { territories: expect.any(String) } });
      expect(await createStandingOrder(tx, buyer.viewer, { ...base, categoryIds: [randomUUID()] })).toMatchObject({ outcome: "invalid", errors: { categories: expect.any(String) } });

      const ok = await createStandingOrder(tx, buyer.viewer, {
        ...base,
        territories: [{ kind: "city", id: ctx.cityId }, { kind: "region", id: "west-yorkshire" }, { kind: "national" }, { kind: "national" }],
        categoryIds: [ctx.primaryCategoryId],
      });
      expect(ok.outcome).toBe("saved");
      const [row] = await standingOrdersFor(tx, buyer.viewer);
      expect(row).toMatchObject({ listingId: buyer.listingId, priceCents: FLOOR, status: "active", categoryIds: [ctx.primaryCategoryId] });
      expect(row!.territories).toHaveLength(3);
      expect(await standingOrdersFor(tx, other.viewer)).toHaveLength(0);
    });
  });

  it("are capped at five per listing", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const buyer = await makeBuyer(tx, ctx);
      const input = { listingId: buyer.listingId, territories: [{ kind: "national" as const }], categoryIds: null, priceCents: FLOOR };
      for (let i = 0; i < 5; i++) expect((await createStandingOrder(tx, buyer.viewer, input)).outcome).toBe("saved");
      expect(await createStandingOrder(tx, buyer.viewer, input)).toEqual({ outcome: "limit" });
    });
  });

  it("are edited, paused, resumed (clearing a no-credit pause) and deleted by their owner only", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const buyer = await makeBuyer(tx, ctx);
      const stranger = await makeBuyer(tx, ctx);
      const id = await makeStandingOrder(tx, buyer, { status: "paused", pausedReason: "no_credit" });

      expect(await setStandingOrderStatus(tx, stranger.viewer, id, "active")).toEqual({ outcome: "not-found" });
      expect((await setStandingOrderStatus(tx, buyer.viewer, id, "active")).outcome).toBe("saved");
      let [row] = await tx.select().from(leadStandingOrders).where(eq(leadStandingOrders.id, id));
      expect(row).toMatchObject({ status: "active", pausedReason: null });
      await setStandingOrderStatus(tx, buyer.viewer, id, "paused");
      [row] = await tx.select().from(leadStandingOrders).where(eq(leadStandingOrders.id, id));
      expect(row).toMatchObject({ status: "paused", pausedReason: "user" });

      expect((await updateStandingOrder(tx, buyer.viewer, id, { territories: [{ kind: "city", id: ctx.cityId }], categoryIds: [], priceCents: FLOOR + 500 })).outcome).toBe("saved");
      [row] = await tx.select().from(leadStandingOrders).where(eq(leadStandingOrders.id, id));
      expect(row).toMatchObject({ priceCents: FLOOR + 500, categoryIds: null, territories: [{ kind: "city", id: ctx.cityId }] });

      expect(await deleteStandingOrder(tx, stranger.viewer, id)).toEqual({ outcome: "not-found" });
      expect((await deleteStandingOrder(tx, buyer.viewer, id)).outcome).toBe("saved");
      expect(await tx.select().from(leadStandingOrders).where(eq(leadStandingOrders.id, id))).toHaveLength(0);
      const audits = await tx.select({ action: auditLog.action }).from(auditLog).where(eq(auditLog.entityId, id));
      expect(audits.map((a) => a.action)).toEqual(expect.arrayContaining(["lead.standing_order_resumed", "lead.standing_order_paused", "lead.standing_order_updated", "lead.standing_order_deleted"]));
    });
  });
});

describe("sweepLeads", () => {
  it("expires open leads at expires_at and deletes unsold ones seven days after", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const buyer = await makeBuyer(tx, ctx, 10_000);
      const fresh = await makeLead(tx, ctx, { expiresAt: at(1) });
      const due = await makeLead(tx, ctx, { expiresAt: at(-0.01) });
      const recentlyExpired = await makeLead(tx, ctx, { status: "expired", expiresAt: at(-6.9) });
      const old = await makeLead(tx, ctx, { status: "expired", expiresAt: at(-7.01) });
      const oldDeleted = await makeLead(tx, ctx, { status: "deleted", expiresAt: at(-7.01) });
      const soldLong = await makeLead(tx, ctx, { expiresAt: at(3) });
      await buyLead(tx, buyer.viewer, soldLong, buyer.listingId, NOW);
      await tx.update(leads).set({ expiresAt: at(-30) }).where(eq(leads.id, soldLong));

      const out = await sweepLeads(tx, SYSTEM, NOW);
      expect(out.expired).toBeGreaterThanOrEqual(1);
      const rows = await tx.select({ id: leads.id, status: leads.status }).from(leads)
        .where(inArray(leads.id, [fresh, due, recentlyExpired, old, oldDeleted, soldLong]));
      const status = Object.fromEntries(rows.map((r) => [r.id, r.status]));
      expect(status).toEqual({ [fresh]: "open", [due]: "expired", [recentlyExpired]: "expired", [soldLong]: "sold" });
      await expect(sweepLeads(tx, buyer.viewer, NOW)).rejects.toThrow(/FORBIDDEN/);
    });
  });
});

describe("admin", () => {
  it("deletes a lead off the board, audited", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const leadId = await makeLead(tx, ctx);
      const staff = await admin(tx);
      expect(await adminDeleteLead(tx, staff, leadId)).toBe(true);
      expect(await adminDeleteLead(tx, staff, leadId)).toBe(false);
      const [row] = await tx.select().from(leads).where(eq(leads.id, leadId));
      expect(row!.status).toBe("deleted");
      expect(await tx.select().from(auditLog).where(and(eq(auditLog.action, "lead.deleted"), eq(auditLog.entityId, leadId)))).toHaveLength(1);
    });
  });
});

describe("the weekly board digest", () => {
  it("goes to accounts with an active standing order or a purchase in 90 days, counting open leads in their territories", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const elsewhere = await makeCity(tx, "Truro", "Cornwall");
      const ordered = await makeBuyer(tx, ctx, 10_000);
      await makeStandingOrder(tx, ordered, { territories: [{ kind: "region", id: "west-yorkshire" }], status: "active" });
      const recentBuyer = await makeBuyer(tx, ctx, 10_000);
      const lapsed = await makeBuyer(tx, ctx, 10_000);
      const optedOut = await makeBuyer(tx, ctx, 10_000);
      await makeStandingOrder(tx, optedOut);
      await setLeadDigestOptOut(tx, optedOut.viewer, { profileId: optedOut.profileId, optOut: true });

      const bought = await makeLead(tx, ctx, {}, at(-10));
      await buyLead(tx, recentBuyer.viewer, bought, recentBuyer.listingId, at(-10));
      const old = await makeLead(tx, ctx, { expiresAt: at(10) }, at(-100));
      await buyLead(tx, lapsed.viewer, old, lapsed.listingId, at(-95));

      await makeLead(tx, ctx, {}, NOW);
      await makeLead(tx, ctx, {}, NOW);
      await makeLead(tx, { cityId: elsewhere, primaryCategoryId: ctx.primaryCategoryId }, {}, NOW);

      const recipients = await boardDigestRecipients(tx, SYSTEM, NOW);
      expect(recipients).toEqual(expect.arrayContaining([ordered.profileId, recentBuyer.profileId]));
      expect(recipients).not.toContain(lapsed.profileId);
      expect(recipients).not.toContain(optedOut.profileId);

      // Two open leads in West Yorkshire; none of the Cornish one.
      expect(await boardDigestFor(tx, SYSTEM, ordered.profileId, NOW)).toMatchObject({ email: ordered.email, openCount: 2 });
      // No active order: its listing's town.
      expect(await boardDigestFor(tx, SYSTEM, recentBuyer.profileId, NOW)).toMatchObject({ openCount: 2 });
      expect(await boardDigestFor(tx, SYSTEM, optedOut.profileId, NOW)).toBeNull();
    });
  });

  it("the unsubscribe link opts out only while the token's address is still the account's", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const buyer = await makeBuyer(tx, ctx);
      expect(await setLeadDigestOptOut(tx, { role: "public" }, { profileId: buyer.profileId, email: "old@example.com", optOut: true })).toBe(false);
      expect(await setLeadDigestOptOut(tx, { role: "public" }, { profileId: buyer.profileId, email: buyer.email.toUpperCase(), optOut: true })).toBe(true);
      const [p] = await tx.select({ off: profiles.leadDigestOptOut }).from(profiles).where(eq(profiles.id, buyer.profileId));
      expect(p!.off).toBe(true);
      // A link can never opt back in, and nobody changes another account's setting.
      await expect(setLeadDigestOptOut(tx, { role: "public" }, { profileId: buyer.profileId, email: buyer.email, optOut: false })).rejects.toThrow(/FORBIDDEN/);
      const other = await makeBuyer(tx, ctx);
      await expect(setLeadDigestOptOut(tx, other.viewer, { profileId: buyer.profileId, optOut: false })).rejects.toThrow(/FORBIDDEN/);
    });
  });
});

describe("leadWonNotification", () => {
  it("carries the contact details for the worker only, and nothing once the lead is deleted", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const buyer = await makeBuyer(tx, ctx, 10_000);
      await makeStandingOrder(tx, buyer);
      const leadId = await makeLead(tx, ctx);
      const sold = await allocateLead(tx, SYSTEM, leadId);
      const purchaseId = (sold as { purchaseId: string }).purchaseId;
      await expect(leadWonNotification(tx, buyer.viewer, purchaseId)).rejects.toThrow(/FORBIDDEN/);
      expect(await leadWonNotification(tx, SYSTEM, purchaseId)).toMatchObject({ email: buyer.email, name: "Sam Requester", phone: expect.stringMatching(/^01632 97\d{4}$/) });
      await adminDeleteLead(tx, SYSTEM, leadId);
      expect(await leadWonNotification(tx, SYSTEM, purchaseId)).toBeNull();
    });
  });
});

/**
 * Two buyers press "buy" on one lead at the same moment, on two connections.
 * Committed rows, so both transactions really run at once; cleaned up after.
 */
describe("buyLead concurrency", () => {
  const url = process.env.TEST_DATABASE_URL ?? "postgres://directory:directory@localhost:5433/directory_test";
  const client = postgres(url, { max: 4, onnotice: () => {} });
  const database = drizzle(client, { schema });
  const made: { users: string[]; cityId?: string; verticalId?: string; categoryId?: string; listingIds: string[]; leadId?: string } = { users: [], listingIds: [] };

  afterAll(async () => {
    if (made.leadId) {
      await database.delete(leadPurchases).where(eq(leadPurchases.leadId, made.leadId));
      await database.delete(auditLog).where(eq(auditLog.entityId, made.leadId));
      await database.delete(leads).where(eq(leads.id, made.leadId));
    }
    if (made.listingIds.length > 0) await database.delete(listings).where(inArray(listings.id, made.listingIds));
    if (made.users.length > 0) await database.delete(user).where(inArray(user.id, made.users));
    const entityIds = [made.cityId, made.categoryId, made.verticalId, ...made.listingIds].filter((x): x is string => !!x);
    if (entityIds.length > 0) await database.delete(slugs).where(inArray(slugs.entityId, entityIds));
    if (made.categoryId) await database.delete(categories).where(eq(categories.id, made.categoryId));
    if (made.cityId) await database.delete(cities).where(eq(cities.id, made.cityId));
    if (made.verticalId) await database.delete(verticals).where(eq(verticals.id, made.verticalId));
    await client.end({ timeout: 5 });
  });

  it("sells to exactly one of two simultaneous buyers and debits only the winner", async () => {
    const setup = await database.transaction(async (raw) => {
      const tx = raw as unknown as TestDb;
      // Committed while the test runs, so every name is unique: a "Leeds" or a
      // "Barn Venues" here would collide with every other file's scaffold.
      const tag = randomUUID().slice(0, 8);
      const verticalId = await makeVertical(tx, `Race Vertical ${tag}`);
      const cityId = await makeCity(tx, `Race Town ${tag}`, `Race Region ${tag}`);
      const ctx = { cityId, verticalId, primaryCategoryId: await makeCategoryInCity(tx, verticalId, cityId, `Race Things ${tag}`) };
      const a = await makeBuyer(tx, ctx, 5000);
      const b = await makeBuyer(tx, ctx, 5000);
      // A normalised phone no rule-checked test can draw, so this committed
      // row is never another file's "duplicate".
      const leadId = await makeLead(tx, ctx, { phoneNormalised: `race-${tag}` });
      return { ctx, a, b, leadId };
    });
    Object.assign(made, {
      users: [setup.a.authUserId, setup.b.authUserId], cityId: setup.ctx.cityId, verticalId: setup.ctx.verticalId,
      categoryId: setup.ctx.primaryCategoryId, listingIds: [setup.a.listingId, setup.b.listingId], leadId: setup.leadId,
    });

    const attempt = (who: typeof setup.a) =>
      database.transaction(async (raw) => {
        const out = await buyLead(raw as unknown as TestDb, who.viewer, setup.leadId, who.listingId);
        await new Promise((r) => setTimeout(r, 100));
        return out;
      });
    const results = await Promise.all([attempt(setup.a), attempt(setup.b)]);
    expect(results.map((r) => r.outcome).sort()).toEqual(["bought", "gone"]);

    const db = database as unknown as TestDb;
    const balances = [await creditBalance(db, setup.a.profileId), await creditBalance(db, setup.b.profileId)].sort();
    expect(balances).toEqual([2500, 5000]);
    expect(await database.select().from(leadPurchases).where(eq(leadPurchases.leadId, setup.leadId))).toHaveLength(1);
  });
});
