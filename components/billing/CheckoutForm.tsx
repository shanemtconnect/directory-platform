"use client";

import { useActionState } from "react";
import { startCheckoutAction, type CheckoutState } from "@/lib/actions/billing";
import { Notice } from "@/components/ui/Notice";
import { SubmitButton } from "@/components/ui/SubmitButton";

const initial: CheckoutState = { status: "idle" };

export interface CheckoutFormProps {
  listingId: string;
  tier: string;
  interval: string;
  /** Shown on the button, e.g. "Continue to PayPal". */
  providerLabel: string;
  /** Prefilled from `?coupon=`, so an outreach link carries its own code. */
  defaultCoupon?: string;
}

/**
 * Three hidden fields and a coupon box.
 *
 * The tier, interval and listing are hidden rather than re-read from the URL
 * by the action, so that what the buyer was shown is what the action prices —
 * and the action re-checks ownership of the listing regardless, because a
 * hidden field is only a suggestion.
 */
export function CheckoutForm({
  listingId,
  tier,
  interval,
  providerLabel,
  defaultCoupon,
}: CheckoutFormProps) {
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
          defaultValue={defaultCoupon}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={Boolean(state.couponError)}
          aria-describedby={state.couponError ? "coupon-error" : undefined}
          data-testid="coupon-input"
        />
        {state.couponError && (
          <span role="alert" id="coupon-error" data-testid="coupon-error">
            {state.couponError}
          </span>
        )}
      </p>

      {state.message && (
        <Notice variant="error" testId="checkout-error">
          {state.message}
          {state.billingLink && (
            <>
              {" "}
              <a href="/account/billing">Go to Billing</a>
            </>
          )}
        </Notice>
      )}

      <div className="form-actions">
        <SubmitButton pending={pending} pendingLabel="Taking you to PayPal…" testId="checkout-submit" block>
          {providerLabel}
        </SubmitButton>
      </div>

      <p className="text-sm text-muted">
        Payment is taken by PayPal. We never see or store your card details.
      </p>
    </form>
  );
}
