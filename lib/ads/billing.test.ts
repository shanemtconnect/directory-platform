import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { siteConfig } from "@/config/site.config";
import { resetClock, setClock } from "@/lib/clock";
import { parseEvent, type PayPalEvent } from "@/lib/billing/webhooks";
import { processPayPalWebhook } from "@/lib/billing/process";
import type { CreateSubscriptionInput, PayPalClient } from "@/lib/billing/paypal";
import * as fx from "@/lib/billing/__fixtures__/paypal";
import { auditLog, profiles, sponsorCampaigns, user } from "@/lib/db/schema";
import { ADMIN_VIEWER } from "@/worker/viewer";
import type { Viewer } from "@/lib/db/viewer";
import { withTestDb, type TestDb } from "@/test/db";
import { createSponsorCampaign, decideSponsorCampaign, type SponsorBillingRow } from "@/lib/db/queries/ads";
import {
  SPONSOR_PLAN_ENV,
  applySponsorBillingEvent,
  decideSponsor,
  sponsorPlanId,
  sponsorPlanRequestBody,
  startSponsorCheckout,
} from "./billing";

const AT = new Date("2026-09-22T10:00:00Z");
const END = new Date("2026-10-12T09:00:00Z");
const ENV = { [SPONSOR_PLAN_ENV]: "P-SPONSOR" };

afterEach(resetClock);

const row = (over: Partial<SponsorBillingRow> = {}): SponsorBillingRow => ({
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  status: "active",
  billingStatus: "approval_pending",
  currentPeriodEnd: null,
  endsAt: null,
  ...over,
});

const ev = (raw: unknown): PayPalEvent => parseEvent(raw)!;

describe("the plan", () => {
  it("is one open-ended monthly REGULAR cycle at the configured price, and its env var is optional", () => {
    const body = sponsorPlanRequestBody("PROD-1");
    expect(body.billing_cycles).toHaveLength(1);
    expect(body.billing_cycles[0]).toMatchObject({
      tenure_type: "REGULAR", sequence: 1, total_cycles: 0,
      frequency: { interval_unit: "MONTH", interval_count: 1 },
      pricing_scheme: { fixed_price: { value: siteConfig.ads.monthlyPrice.toFixed(2), currency_code: siteConfig.currency } },
    });
    expect(sponsorPlanId({})).toBeNull();
    expect(sponsorPlanId({ [SPONSOR_PLAN_ENV]: "  " })).toBeNull();
    expect(sponsorPlanId(ENV)).toBe("P-SPONSOR");
  });
});

describe("decideSponsor", () => {
  it("activation → active with PayPal's period end and no end date", () => {
    expect(decideSponsor(ev(fx.activated()), row(), AT)).toEqual({
      action: "activate", billingStatus: "active", currentPeriodEnd: END, endsAt: null,
    });
  });

  it("activation without a billing time invents one month from now rather than nothing", () => {
    const got = decideSponsor(ev(fx.activated({ billing_info: {} })), row(), AT);
    expect(got).toMatchObject({ action: "activate", currentPeriodEnd: new Date("2026-10-22T10:00:00Z") });
  });

  it("a sale renews to the next billing time; a failed payment is past due and keeps showing", () => {
    expect(decideSponsor(ev(fx.saleCompleted()), row({ billingStatus: "active", currentPeriodEnd: END }), AT))
      .toMatchObject({ action: "renew", billingStatus: "active" });
    expect(decideSponsor(ev(fx.paymentFailed()), row({ billingStatus: "active", currentPeriodEnd: END }), AT))
      .toMatchObject({ action: "past-due", billingStatus: "past_due", endsAt: undefined });
  });

  it("cancelling mid-period ends the campaign at the period end; after it, now", () => {
    expect(decideSponsor(ev(fx.cancelled()), row({ billingStatus: "active", currentPeriodEnd: END }), AT))
      .toMatchObject({ action: "cancel", billingStatus: "cancelled", endsAt: END });
    const late = new Date(END.getTime() + 1000);
    expect(decideSponsor(ev(fx.cancelled()), row({ billingStatus: "active", currentPeriodEnd: END }), late))
      .toMatchObject({ action: "cancel", endsAt: late });
  });

  it("suspension and expiry lapse at once; an unknown event is ignored", () => {
    expect(decideSponsor(ev(fx.suspended()), row({ billingStatus: "active" }), AT)).toMatchObject({ action: "lapse", billingStatus: "suspended" });
    expect(decideSponsor(ev(fx.expired()), row({ billingStatus: "active" }), AT)).toMatchObject({ action: "lapse", billingStatus: "expired" });
    expect(decideSponsor(ev(fx.unknownEvent()), row(), AT)).toMatchObject({ action: "ignore" });
  });
});

async function advertiser(tx: TestDb): Promise<{ viewer: Viewer; profileId: string }> {
  const userId = `u_${randomUUID()}`;
  await tx.insert(user).values({ id: userId, name: "Adv", email: `${userId}@example.com` });
  const [p] = await tx.insert(profiles).values({ userId }).returning({ id: profiles.id });
  return { viewer: { role: "user", userId }, profileId: p!.id };
}

async function campaign(tx: TestDb, a: { viewer: Viewer; profileId: string }): Promise<string> {
  const r = await createSponsorCampaign(tx, a.viewer, {
    profileId: a.profileId, name: "Acme", title: "t", blurb: "b",
    targetUrl: "https://acme.example/", placements: ["search"], logoPath: null, ip: null,
  });
  if (r.outcome !== "created") throw new Error(r.outcome);
  return r.campaignId;
}

function fakeClient(created: CreateSubscriptionInput[] = []): PayPalClient {
  return {
    createSubscription: async (input) => {
      created.push(input);
      return { id: fx.SUB_ID, status: "APPROVAL_PENDING", approveUrl: "https://paypal/approve" };
    },
    getSubscription: async () => null,
    cancelSubscription: async () => {},
    manageUrl: async () => null,
    verifyWebhookSignature: async () => true,
  };
}

describe("startSponsorCheckout", () => {
  it("is not configured without a client or a plan id, and touches nothing", async () => {
    await withTestDb(async (tx) => {
      const a = await advertiser(tx);
      const id = await campaign(tx, a);
      expect(await startSponsorCheckout(tx, { client: null, env: ENV, viewer: a.viewer, profileId: a.profileId, campaignId: id }))
        .toEqual({ outcome: "not-configured" });
      expect(await startSponsorCheckout(tx, { client: fakeClient(), env: {}, viewer: a.viewer, profileId: a.profileId, campaignId: id }))
        .toEqual({ outcome: "not-configured" });
      const [r] = await tx.select().from(sponsorCampaigns).where(eq(sponsorCampaigns.id, id));
      expect(r!.billingStatus).toBe("none");
    });
  });

  it("creates the subscription with the campaign as custom_id and records the provider id", async () => {
    await withTestDb(async (tx) => {
      const a = await advertiser(tx);
      const id = await campaign(tx, a);
      const created: CreateSubscriptionInput[] = [];
      const out = await startSponsorCheckout(tx, { client: fakeClient(created), env: ENV, viewer: a.viewer, profileId: a.profileId, campaignId: id });
      expect(out).toEqual({ outcome: "approval", approveUrl: "https://paypal/approve" });
      expect(created[0]).toMatchObject({ planId: "P-SPONSOR", customId: id });
      expect(created[0]!.returnUrl).toContain("/advertise/sponsor/return");
      const [r] = await tx.select().from(sponsorCampaigns).where(eq(sponsorCampaigns.id, id));
      expect(r).toMatchObject({ subscriptionId: fx.SUB_ID, billingStatus: "approval_pending" });
    });
  });

  it("refuses somebody else's campaign", async () => {
    await withTestDb(async (tx) => {
      const a = await advertiser(tx);
      const b = await advertiser(tx);
      const id = await campaign(tx, a);
      expect(await startSponsorCheckout(tx, { client: fakeClient(), env: ENV, viewer: b.viewer, profileId: b.profileId, campaignId: id }))
        .toEqual({ outcome: "not-owner" });
    });
  });
});

describe("the webhook path", () => {
  it("applySponsorBillingEvent finds the campaign by custom_id before the redirect is followed", async () => {
    await withTestDb(async (tx) => {
      setClock(AT);
      const a = await advertiser(tx);
      const id = await campaign(tx, a);
      const out = await applySponsorBillingEvent(tx, ADMIN_VIEWER, ev(fx.activated({ custom_id: id })), {
        providerSubscriptionId: fx.SUB_ID, customId: id,
      });
      // provider id is unknown yet → falls through to custom_id? No: provider first, and it is not attached.
      expect(out.outcome).toBe("unknown-subscription");
      const byCustom = await applySponsorBillingEvent(tx, ADMIN_VIEWER, ev(fx.activated({ custom_id: id })), {
        providerSubscriptionId: null, customId: id,
      });
      expect(byCustom).toEqual({ outcome: "applied", detail: "activate" });
    });
  });

  it("processPayPalWebhook applies a sponsor event that names no listing subscription, then a cancel", async () => {
    await withTestDb(async (tx) => {
      setClock(AT);
      const a = await advertiser(tx);
      const id = await campaign(tx, a);
      await decideSponsorCampaign(tx, ADMIN_VIEWER, id, { decision: "approve", ip: null });
      await startSponsorCheckout(tx, { client: fakeClient(), env: ENV, viewer: a.viewer, profileId: a.profileId, campaignId: id });

      const post = (raw: unknown) => ({ raw: JSON.stringify(raw), headers: { "paypal-transmission-id": "x" } });
      const activated = await processPayPalWebhook(tx, { client: fakeClient(), env: {}, ...post(fx.activated()) });
      expect(activated).toMatchObject({ status: 200, outcome: "applied", detail: "activate" });
      let [r] = await tx.select().from(sponsorCampaigns).where(eq(sponsorCampaigns.id, id));
      expect(r).toMatchObject({ billingStatus: "active", currentPeriodEnd: END, endsAt: null });

      const cancelled = await processPayPalWebhook(tx, { client: fakeClient(), env: {}, ...post(fx.cancelled()) });
      expect(cancelled).toMatchObject({ status: 200, outcome: "applied", detail: "cancel" });
      [r] = await tx.select().from(sponsorCampaigns).where(eq(sponsorCampaigns.id, id));
      expect(r).toMatchObject({ billingStatus: "cancelled", endsAt: END });

      const audits = await tx.select().from(auditLog).where(eq(auditLog.entityId, id));
      expect(audits.filter((x) => x.action === "sponsor.billing")).toHaveLength(2);
    });
  });

  it("an event for nobody is still unknown-subscription", async () => {
    await withTestDb(async (tx) => {
      const out = await processPayPalWebhook(tx, {
        client: fakeClient(), env: {},
        raw: JSON.stringify(fx.activated()), headers: { "paypal-transmission-id": "x" },
      });
      expect(out).toMatchObject({ status: 200, outcome: "unknown-subscription" });
    });
  });
});
