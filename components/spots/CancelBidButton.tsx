"use client";

import { useActionState, useState } from "react";
import { cancelBidAction, type CancelBidState } from "@/lib/actions/spots";
import { Notice } from "@/components/ui/Notice";
import { SubmitButton } from "@/components/ui/SubmitButton";

const initial: CancelBidState = { status: "idle" };

/** Two clicks: a cancelled bid loses its place in the queue for good. */
export function CancelBidButton({ listingId, spotId }: { listingId: string; spotId: string }) {
  const [state, action, pending] = useActionState(cancelBidAction, initial);
  const [confirming, setConfirming] = useState(false);

  if (state.status === "cancelled") {
    return <Notice variant="success" testId="cancel-bid-done">{state.message}</Notice>;
  }

  if (!confirming) {
    return (
      <button type="button" className="btn btn-secondary" onClick={() => setConfirming(true)} data-testid="cancel-bid">
        Cancel bid
      </button>
    );
  }

  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="listingId" value={listingId} />
      <input type="hidden" name="spotId" value={spotId} />
      <p className="mb-0 text-sm text-muted">Your place in this spot goes to the next bid. Sure?</p>
      <div className="flex gap-2">
        <SubmitButton pending={pending} pendingLabel="Cancelling…" testId="cancel-bid-confirm" variant="secondary">
          Yes, cancel it
        </SubmitButton>
        <button type="button" className="btn" onClick={() => setConfirming(false)}>Keep it</button>
      </div>
      {state.message && <Notice variant="error" testId="cancel-bid-error">{state.message}</Notice>}
    </form>
  );
}
