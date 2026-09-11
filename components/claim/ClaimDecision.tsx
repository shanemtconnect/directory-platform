"use client";

import { useActionState } from "react";
import { decideClaimAction, type DecisionState } from "@/lib/actions/claim";

const initial: DecisionState = { status: "idle" };

/**
 * Approve and reject as two submits on one form, so the reason box belongs to
 * the decision it explains and an admin cannot approve while a rejection
 * reason sits half-typed above.
 */
export function ClaimDecision({ claimId }: { claimId: string }) {
  const [state, action, pending] = useActionState(decideClaimAction, initial);

  if (state.status === "done") {
    return (
      <p role="status" data-testid="claim-decided">
        Decision recorded. <a href="/admin/claims">Back to the queue</a>.
      </p>
    );
  }

  return (
    <form action={action} data-testid="claim-decision" className="card">
      <input type="hidden" name="claimId" value={claimId} />

      <p>
        <label htmlFor="claim-reason">Reason (required to reject, sent to the claimant)</label>
        <textarea id="claim-reason" name="reason" rows={3} maxLength={500} />
      </p>

      {state.message && <p role="alert" data-testid="claim-decision-error">{state.message}</p>}

      <div className="flex gap-3">
        <button
          type="submit" name="decision" value="approved" disabled={pending}
          className="btn btn-primary"
        >
          {pending ? "Saving…" : "Approve"}
        </button>
        <button type="submit" name="decision" value="rejected" disabled={pending} className="btn">
          Reject
        </button>
      </div>
    </form>
  );
}
