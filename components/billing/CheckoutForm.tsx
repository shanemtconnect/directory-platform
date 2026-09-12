"use client";

import { useActionState } from "react";
import { startCheckoutAction, type CheckoutState } from "@/lib/actions/billing";

const initial: CheckoutState = { status: "idle" };

export interface CheckoutFormProps {
  listingId: string;
  tier: string;
  interval: string;
  /** Shown on the button, e.g. "Continue to PayPal". */
  providerLabel: string;
}

/**
 * Three hidden fields and a coupon box.
 *
 * The tier, interval and listing are hidden rather than re-read from the URL
 * by the action, so that what the buyer was shown is what the action prices —
 * and the action re-checks ownership of the listing regardless, because a
 * hidden field is only a suggestion.
 */
export function CheckoutForm({ listingId, tier, interval, providerLabel }: CheckoutFormProps) {
  const [state, action, pending] = useActionState(startCheckoutAction, initial);

  return (
    <form action={action} data-testid="checkout-form" className="card">
      <input type="hidden" name="listingId" value={listingId} />
      <input type="hidden" name="tier" value={tier} />
      <input type="hidden" name="interval" value={interval} />

      <p>
        <label htmlFor="coupon">Discount code (optional)</label>
        <input
          id="coupon"
          name="coupon"
          maxLength={64}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={Boolean(state.couponError)}
          data-testid="coupon-input"
        />
        {state.couponError && (
          <span role="alert" data-testid="coupon-error">
            {state.couponError}
          </span>
        )}
      </p>

      {state.message && (
        <p role="alert" data-testid="checkout-error">
          {state.message}
        </p>
      )}

      <p>
        <button type="submit" disabled={pending} data-testid="checkout-submit">
          {pending ? "Taking you to PayPal…" : providerLabel}
        </button>
      </p>

      <p className="text-sm text-muted">
        Payment is taken by PayPal. We never see or store your card details.
      </p>
    </form>
  );
}
