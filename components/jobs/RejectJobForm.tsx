"use client";

import { useActionState } from "react";
import { rejectJobAction, type RejectJobState } from "@/lib/actions/jobs";
import { Notice } from "@/components/ui/Notice";
import { SubmitButton } from "@/components/ui/SubmitButton";

const initial: RejectJobState = { status: "idle" };

/** Rejection wants a reason: the poster is told it, so the admin has to write one. */
export function RejectJobForm({ jobId }: { jobId: string }) {
  const [state, action, pending] = useActionState(rejectJobAction, initial);
  const reasonId = `reject-reason-${jobId}`;
  return (
    <form action={action} className="mt-3" data-testid="reject-job-form">
      <input type="hidden" name="jobId" value={jobId} />
      {state.status === "error" && (
        <Notice variant="error" testId="reject-job-error">
          {state.message}
        </Notice>
      )}
      <p>
        <label htmlFor={reasonId}>Reason (sent to the poster)</label>
        <textarea id={reasonId} name="reason" rows={2} required maxLength={500} />
      </p>
      <SubmitButton pending={pending} pendingLabel="Turning down…" variant="secondary" testId="reject-job">
        Turn down
      </SubmitButton>
    </form>
  );
}
