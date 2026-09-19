"use client";

import { useActionState, useState } from "react";
import { cancelSubscriptionAction, type CancelState } from "@/lib/actions/billing";
import { Notice } from "@/components/ui/Notice";
import { SubmitButton } from "@/components/ui/SubmitButton";

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
      <Notice variant="success" testId="cancel-done">
        {state.message}
      </Notice>
    );
  }

  if (!confirming) {
    return (
      <p>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => setConfirming(true)}
          data-testid="cancel-start"
        >
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
        <Notice variant="error" testId="cancel-error">
          {state.message}
        </Notice>
      )}
      <div className="form-actions">
        <SubmitButton pending={pending} pendingLabel="Cancelling…" testId="cancel-confirm">
          Yes, cancel it
        </SubmitButton>
        <button type="button" className="btn btn-secondary" onClick={() => setConfirming(false)}>
          Keep it
        </button>
      </div>
    </form>
  );
}
