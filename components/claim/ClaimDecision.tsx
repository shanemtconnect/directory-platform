"use client";

import { useActionState } from "react";
import { decideClaimAction, type DecisionState } from "@/lib/actions/claim";
import { Notice } from "@/components/ui/Notice";
import { SubmitButton } from "@/components/ui/SubmitButton";

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
      <Notice variant="success" testId="claim-decided" title="Decision recorded.">
        <p>
          The claimant is being emailed the outcome. <a href="/admin/claims">Back to the queue</a>.
        </p>
      </Notice>
    );
  }

  return (
    <form action={action} data-testid="claim-decision" className="card">
      <input type="hidden" name="claimId" value={claimId} />

      <p>
        <label htmlFor="claim-reason">Reason (required to reject, sent to the claimant)</label>
        <textarea id="claim-reason" name="reason" rows={3} maxLength={500} />
      </p>

      {state.message && (
        <Notice variant="error" testId="claim-decision-error">
          {state.message}
        </Notice>
      )}

      <div className="form-actions">
        <SubmitButton pending={pending} pendingLabel="Saving…" name="decision" value="approved">
          Approve
        </SubmitButton>
        <SubmitButton
          pending={pending}
          pendingLabel="Saving…"
          variant="secondary"
          name="decision"
          value="rejected"
        >
          Reject
        </SubmitButton>
      </div>
    </form>
  );
}
