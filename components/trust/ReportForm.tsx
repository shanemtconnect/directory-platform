"use client";

import { useActionState } from "react";
import { submitReport, type TrustFormState } from "@/lib/actions/trust";
import { TurnstileWidget } from "@/components/submit/TurnstileWidget";
import { REPORT_REASON_LABELS } from "@/lib/trust/labels";
import type { ReportReason } from "@/lib/db/queries/trust";

const initial: TrustFormState = { status: "idle" };

/**
 * Type-only import of `ReportReason`, so this list is checked against the
 * database enum without dragging the data layer into the browser bundle. A
 * reason added to the enum and not to this list is a type error, not a
 * silently missing option.
 */
const REASONS: ReportReason[] = ["incorrect", "closed", "duplicate", "offensive", "other"];

export interface ReportFormProps {
  listingId: string;
  listingName: string;
  /** Null outside production; the server-side check skips in the same case. */
  turnstileSiteKey: string | null;
}

export function ReportForm({ listingId, listingName, turnstileSiteKey }: ReportFormProps) {
  const [state, action, pending] = useActionState(submitReport, initial);
  const err = state.fieldErrors ?? {};

  return (
    <form action={action} data-testid="report-form" className="card max-w-2xl">
      <input type="hidden" name="listingId" value={listingId} />

      {/* Honeypot. Hidden from people and from screen readers, visible to bots. */}
      <div aria-hidden="true" style={{ position: "absolute", left: "-9999px" }}>
        <label htmlFor="company_website">Leave this field empty</label>
        <input id="company_website" name="company_website" type="text" tabIndex={-1} autoComplete="off" />
      </div>

      <fieldset>
        <legend>What is wrong with {listingName}?</legend>
        {REASONS.map((reason) => (
          <p key={reason}>
            <label htmlFor={`rp-${reason}`}>
              <input
                id={`rp-${reason}`}
                type="radio"
                name="reason"
                value={reason}
                defaultChecked={reason === "incorrect"}
              />{" "}
              {REPORT_REASON_LABELS[reason]}
            </label>
          </p>
        ))}
        {err.reason && <span role="alert">{err.reason}</span>}
      </fieldset>

      <p>
        <label htmlFor="rp-detail">What should it say instead?</label>
        <textarea id="rp-detail" name="detail" rows={5} maxLength={1000}
          aria-invalid={Boolean(err.detail)} />
        {err.detail && <span role="alert">{err.detail}</span>}
      </p>

      <p>
        <label htmlFor="rp-email">Your email (optional)</label>
        <input id="rp-email" name="reporterEmail" type="email" maxLength={254}
          aria-invalid={Boolean(err.reporterEmail)} autoComplete="email" />
        {err.reporterEmail && <span role="alert">{err.reporterEmail}</span>}
        <small className="text-muted">
          Only so we can ask a question if we need to. We won&rsquo;t add you to anything.
        </small>
      </p>

      {/* Without this the action rejects every report the moment a secret is
          configured: it requires a token it was never sent. */}
      <TurnstileWidget siteKey={turnstileSiteKey} resetOn={state} />

      {state.status === "error" && state.message && (
        <p role="alert" data-testid="report-error">{state.message}</p>
      )}

      <button type="submit" disabled={pending} className="btn btn-primary">
        {pending ? "Sending…" : "Send report"}
      </button>
    </form>
  );
}
