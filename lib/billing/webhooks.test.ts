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
    cancelAtPeriodEnd: false,
    ...patch,
  };
}

const NO_TRIAL = () => 0;
const THIRTY_DAY_TRIAL = () => 30;

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

  it("records the trial end on activation only for a tier that has a trial", () => {
    const withTrial = decide(parseEvent(fx.activated())!, current(), { ...opts, trialDays: THIRTY_DAY_TRIAL });
    expect(withTrial.action !== "ignore" && withTrial.trialEndsAt?.toISOString()).toBe(
      "2026-10-12T09:00:00.000Z",
    );

    // A clone with trialDays: 0 is charged at activation. There is no trial
    // to end, so the billing page must not say "Free trial ends <date>".
    const noTrial = decide(parseEvent(fx.activated())!, current(), { ...opts, trialDays: NO_TRIAL });
    expect(noTrial.action !== "ignore" && noTrial.trialEndsAt).toBeNull();
    expect(noTrial.action !== "ignore" && noTrial.currentPeriodEnd?.toISOString()).toBe(
      "2026-10-12T09:00:00.000Z",
    );
  });

  it("activation clears a cancel flag — a re-activated subscription is not cancelling", () => {
    const e = decide(parseEvent(fx.activated())!, current({ cancelAtPeriodEnd: true }), opts);
    expect(e).toMatchObject({ action: "activate", cancelAtPeriodEnd: false });
  });

  it("keeps the owner's cancel flag through an update, a failed payment and a sale", () => {
    // requestCancellation sets cancel_at_period_end before the CANCELLED
    // webhook lands. Any other event in between must not flip it back and
    // hide the cancellation on the billing page.
    const cancelling = current({
      status: "active",
      cancelAtPeriodEnd: true,
      currentPeriodEnd: new Date("2027-09-12T09:00:00Z"),
    });
    for (const payload of [fx.updated(), fx.paymentFailed(), fx.saleCompleted()]) {
      const e = decide(parseEvent(payload)!, cancelling, opts);
      expect(e, String((payload as { event_type: string }).event_type)).toMatchObject({
        cancelAtPeriodEnd: true,
      });
    }
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

  it("does not add a second interval when the first sale lands seconds after activation", () => {
    // trialDays: 0 — PayPal charges at activation and sends ACTIVATED
    // (next_billing_time = T+1 interval) and PAYMENT.SALE.COMPLETED together,
    // in either order. The sale is for the period ACTIVATED already set, so
    // the period end must not move.
    const activatedAt = new Date("2026-09-12T09:00:10Z");
    const afterActivation = decide(
      parseEvent(fx.activated())!,
      current({ interval: "monthly" }),
      { env: ENV, at: activatedAt, trialDays: NO_TRIAL },
    );
    expect(afterActivation.action).toBe("activate");
    if (afterActivation.action === "ignore") return;

    const e = decide(
      parseEvent(fx.saleCompleted())!,
      current({
        status: "active",
        interval: "monthly",
        currentPeriodEnd: afterActivation.currentPeriodEnd,
      }),
      { env: ENV, at: new Date("2026-09-12T09:00:15Z") },
    );
    expect(e).toMatchObject({ action: "renew", status: "active" });
    expect(e.action !== "ignore" && e.currentPeriodEnd?.toISOString()).toBe("2026-10-12T09:00:00.000Z");
  });

  it("is idempotent across orderings: SALE then ACTIVATED lands on the same date", () => {
    const saleFirst = decide(
      parseEvent(fx.saleCompleted())!,
      current({ interval: "monthly" }),
      { env: ENV, at: new Date("2026-09-12T09:00:05Z") },
    );
    expect(saleFirst.action !== "ignore" && saleFirst.currentPeriodEnd?.toISOString()).toBe(
      "2026-10-12T09:00:05.000Z",
    );
    const thenActivated = decide(
      parseEvent(fx.activated())!,
      current({
        status: "active",
        interval: "monthly",
        currentPeriodEnd: saleFirst.action !== "ignore" ? saleFirst.currentPeriodEnd : null,
      }),
      { env: ENV, at: new Date("2026-09-12T09:00:10Z"), trialDays: NO_TRIAL },
    );
    // PayPal's own next_billing_time wins, and no trial end is invented.
    expect(thenActivated).toMatchObject({ action: "activate", trialEndsAt: null });
    expect(thenActivated.action !== "ignore" && thenActivated.currentPeriodEnd?.toISOString()).toBe(
      "2026-10-12T09:00:00.000Z",
    );
  });

  it("takes next_billing_time from a sale that carries one", () => {
    const e = decide(
      parseEvent(fx.saleCompleted({ billing_info: { next_billing_time: "2028-01-01T00:00:00Z" } }))!,
      current({ status: "active", currentPeriodEnd: new Date("2027-09-12T09:00:00Z") }),
      { env: ENV, at: new Date("2027-09-12T09:00:05Z") },
    );
    expect(e.action !== "ignore" && e.currentPeriodEnd?.toISOString()).toBe("2028-01-01T00:00:00.000Z");
  });

  it("renews through the free-trial path: trial end, then first sale advances one interval", () => {
    // trialDays: 30 — ACTIVATED carries next_billing_time = trial end, no sale
    // is sent until the trial ends, and that sale is the first renewal.
    const act = decide(parseEvent(fx.activated())!, current(), {
      env: ENV, at: new Date("2026-09-12T09:00:10Z"), trialDays: THIRTY_DAY_TRIAL,
    });
    if (act.action === "ignore") throw new Error("unexpected ignore");
    expect(act.trialEndsAt?.toISOString()).toBe("2026-10-12T09:00:00.000Z");

    const sale = decide(
      parseEvent(fx.saleCompleted())!,
      current({ status: "active", currentPeriodEnd: act.currentPeriodEnd, trialEndsAt: act.trialEndsAt }),
      { env: ENV, at: new Date("2026-10-12T09:00:05Z") },
    );
    expect(sale.action !== "ignore" && sale.currentPeriodEnd?.toISOString()).toBe("2027-10-12T09:00:00.000Z");
    expect(sale.action !== "ignore" && sale.trialEndsAt?.toISOString()).toBe("2026-10-12T09:00:00.000Z");
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
