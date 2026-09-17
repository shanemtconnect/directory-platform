"use client";

import { useActionState, useState } from "react";
import { cancelSubscriptionAction, type CancelState } from "@/lib/actions/billing";

const initial: CancelState = { status: "idle" };

/**
 * Two clicks, not one.
 *
 * Cancelling is irreversible from this page — restarting means going through
 * checkout again — and a single button next to a "manage payment method" link
 * is a mis-click away from a customer losing their plan.
 */
export function CancelButton({
  subscriptionId,
  periodEndLabel,
}: {
  subscriptionId: string;
  /** e.g. "12 October 2027". Null when there is no paid period left to keep. */
  periodEndLabel: string | null;
}) {
  const [state, action, pending] = useActionState(cancelSubscriptionAction, initial);
  const [confirming, setConfirming] = useState(false);

  if (state.status === "cancelled") {
    return (
      <p role="status" data-testid="cancel-done">
        {state.message}
      </p>
    );
  }

  if (!confirming) {
    return (
      <p>
        <button type="button" onClick={() => setConfirming(true)} data-testid="cancel-start">
          Cancel this subscription
        </button>
      </p>
    );
  }

  return (
    <form action={action} data-testid="cancel-form">
      <input type="hidden" name="subscriptionId" value={subscriptionId} />
      <p>
        {periodEndLabel === null
          ? "Cancelling stops any further payments."
          : `You keep this plan until ${periodEndLabel}, and it will not renew after that.`}
      </p>
      {state.message && (
        <p role="alert" data-testid="cancel-error">
          {state.message}
        </p>
      )}
      <p>
        <button type="submit" disabled={pending} data-testid="cancel-confirm">
          {pending ? "Cancelling…" : "Yes, cancel it"}
        </button>{" "}
        <button type="button" onClick={() => setConfirming(false)}>
          Keep it
        </button>
      </p>
    </form>
  );
}
