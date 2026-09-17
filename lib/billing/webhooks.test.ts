import { describe, expect, it } from "vitest";
import * as fx from "./__fixtures__/paypal";
import { decide, parseEvent, providerSubscriptionIdFor } from "./webhooks";
import type { CurrentSubscription } from "./webhooks";

const ENV = { PAYPAL_PLAN_PREMIUM_ANNUAL: fx.PLAN_ID };
const AT = new Date("2026-09-12T09:00:10Z");

function current(patch: Partial<CurrentSubscription> = {}): CurrentSubscription {
  return {
    id: "row-1",
    listingId: "listing-1",
    tier: "premium",
    interval: "annual",
    status: "approval_pending",
    currentPeriodEnd: null,
    trialEndsAt: null,
    ...patch,
  };
}

describe("parseEvent", () => {
  it("reads the three fields every handler needs", () => {
    const parsed = parseEvent(fx.activated());
    expect(parsed).toMatchObject({ id: "WH-ACTIVATED-1", type: "BILLING.SUBSCRIPTION.ACTIVATED" });
  });

  it("returns null for anything that is not an event", () => {
    expect(parseEvent(null)).toBeNull();
    expect(parseEvent({})).toBeNull();
    expect(parseEvent({ id: "x" })).toBeNull();
    expect(parseEvent("not json")).toBeNull();
  });
});

describe("providerSubscriptionIdFor", () => {
  it("takes the resource id for a subscription event", () => {
    expect(providerSubscriptionIdFor(parseEvent(fx.activated())!)).toBe(fx.SUB_ID);
  });

  it("takes the billing agreement for a sale", () => {
    expect(providerSubscriptionIdFor(parseEvent(fx.saleCompleted())!)).toBe(fx.SUB_ID);
  });

  it("is null when the payload names none", () => {
    expect(providerSubscriptionIdFor(parseEvent(fx.unknownEvent())!)).toBeNull();
  });
});

describe("decide", () => {
  const opts = { env: ENV, at: AT };

  it("activates: paid tier on the listing, and a verification check opened", () => {
    const e = decide(parseEvent(fx.activated())!, current(), opts);
    expect(e).toMatchObject({
      action: "activate",
      status: "active",
      tier: "premium",
      interval: "annual",
      listingTier: "premium",
      dropVerified: false,
      openVerificationCheck: true,
    });
    expect(e.action !== "ignore" && e.currentPeriodEnd?.toISOString()).toBe("2026-10-12T09:00:00.000Z");
  });

  it("never lets a payment grant the verified badge", () => {
    // Global constraint 30: activation opens a CHECK, it does not pass one.
    const e = decide(parseEvent(fx.activated())!, current(), opts);
    expect(e).not.toHaveProperty("setVerified");
  });

  it("falls back to the row's own tier when the plan id is unknown to this deploy", () => {
    const e = decide(parseEvent(fx.activated())!, current({ tier: "essential" }), { env: {}, at: AT });
    expect(e).toMatchObject({ tier: "essential", listingTier: "essential" });
  });

  it("updates: follows a plan change onto the listing", () => {
    const e = decide(
      parseEvent(fx.updated({ plan_id: "P-ESSENTIAL-M" }))!,
      current(),
      { env: { ...ENV, PAYPAL_PLAN_ESSENTIAL_MONTHLY: "P-ESSENTIAL-M" }, at: AT },
    );
    expect(e).toMatchObject({ action: "update", tier: "essential", interval: "monthly", listingTier: "essential" });
  });

  it("cancels at period end while the period is still running, keeping the tier bought", () => {
    const e = decide(
      parseEvent(fx.cancelled())!,
      current({ status: "active", currentPeriodEnd: new Date("2027-09-12T09:00:00Z") }),
      opts,
    );
    expect(e).toMatchObject({
      action: "cancel",
      status: "cancelled",
      cancelAtPeriodEnd: true,
      listingTier: "premium",
      dropVerified: false,
    });
  });

  it("cancels immediately when the paid period has already run out", () => {
    const e = decide(
      parseEvent(fx.cancelled())!,
      current({ status: "active", currentPeriodEnd: new Date("2026-01-01T00:00:00Z") }),
      opts,
    );
    expect(e).toMatchObject({ listingTier: "free", dropVerified: true });
  });

  it("suspends and expires straight to free, dropping verified back to claimed", () => {
    for (const [payload, status] of [
      [fx.suspended(), "suspended"],
      [fx.expired(), "expired"],
    ] as const) {
      expect(decide(parseEvent(payload)!, current({ status: "active" }), opts)).toMatchObject({
        action: "lapse",
        status,
        listingTier: "free",
        dropVerified: true,
      });
    }
  });

  it("marks a failed payment past due without taking anything away yet", () => {
    // PayPal retries a failed payment; SUSPENDED is the event that ends it.
    const e = decide(parseEvent(fx.paymentFailed())!, current({ status: "active" }), opts);
    expect(e).toMatchObject({
      action: "past-due",
      status: "past_due",
      listingTier: "premium",
      dropVerified: false,
    });
  });

  it("renews on a completed sale, extending the period by the interval", () => {
    const e = decide(
      parseEvent(fx.saleCompleted())!,
      current({ status: "active", currentPeriodEnd: new Date("2027-09-12T09:00:00Z") }),
      { env: ENV, at: new Date("2027-09-12T09:00:05Z") },
    );
    expect(e).toMatchObject({ action: "renew", status: "active", listingTier: "premium" });
    expect(e.action !== "ignore" && e.currentPeriodEnd?.toISOString()).toBe("2028-09-12T09:00:00.000Z");
  });

  it("renews from now when the stored period has already lapsed", () => {
    const e = decide(
      parseEvent(fx.saleCompleted())!,
      current({ status: "suspended", interval: "monthly", currentPeriodEnd: new Date("2020-01-01T00:00:00Z") }),
      { env: ENV, at: new Date("2027-09-12T00:00:00Z") },
    );
    expect(e.action !== "ignore" && e.currentPeriodEnd?.toISOString()).toBe("2027-10-12T00:00:00.000Z");
  });

  it("ignores an event it has no handler for", () => {
    expect(decide(parseEvent(fx.unknownEvent())!, current(), opts)).toMatchObject({ action: "ignore" });
  });
});
