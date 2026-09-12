"use client";

import { useActionState } from "react";
import { submitRemovalRequest, type TrustFormState } from "@/lib/actions/trust";
import { TurnstileWidget } from "@/components/submit/TurnstileWidget";
import { REMOVAL_RELATIONSHIP_LABELS } from "@/lib/trust/labels";
import type { RemovalRelationship } from "@/lib/db/queries/trust";

const initial: TrustFormState = { status: "idle" };

/** Type-only import, so the list is checked but the data layer stays server-side. */
const RELATIONSHIPS: RemovalRelationship[] = ["owner", "employee", "subject", "other"];

export interface RemovalFormProps {
  listingId: string;
  listingName: string;
  turnstileSiteKey: string | null;
}

export function RemovalForm({ listingId, listingName, turnstileSiteKey }: RemovalFormProps) {
  const [state, action, pending] = useActionState(submitRemovalRequest, initial);
  const err = state.fieldErrors ?? {};

  return (
    <form action={action} data-testid="removal-form" className="card max-w-2xl">
      <input type="hidden" name="listingId" value={listingId} />

      {/* Honeypot. Hidden from people and from screen readers, visible to bots. */}
      <div aria-hidden="true" style={{ position: "absolute", left: "-9999px" }}>
        <label htmlFor="company_website">Leave this field empty</label>
        <input id="company_website" name="company_website" type="text" tabIndex={-1} autoComplete="off" />
      </div>

      <p>
        <label htmlFor="rm-name">Your name</label>
        <input id="rm-name" name="requesterName" required maxLength={120}
          aria-invalid={Boolean(err.requesterName)} autoComplete="name" />
        {err.requesterName && <span role="alert">{err.requesterName}</span>}
      </p>

      <p>
        <label htmlFor="rm-email">Your email</label>
        <input id="rm-email" name="requesterEmail" type="email" required maxLength={254}
          aria-invalid={Boolean(err.requesterEmail)} autoComplete="email" />
        {err.requesterEmail && <span role="alert">{err.requesterEmail}</span>}
        <small className="text-muted">This is where we send the answer. Nowhere else.</small>
      </p>

      <fieldset>
        <legend>How are you connected to {listingName}?</legend>
        {RELATIONSHIPS.map((relationship) => (
          <p key={relationship}>
            <label htmlFor={`rm-${relationship}`}>
              <input
                id={`rm-${relationship}`}
                type="radio"
                name="relationship"
                value={relationship}
              />{" "}
              {REMOVAL_RELATIONSHIP_LABELS[relationship]}
            </label>
          </p>
        ))}
        {err.relationship && <span role="alert">{err.relationship}</span>}
      </fieldset>

      <p>
        <label htmlFor="rm-reason">Anything you want to tell us (optional)</label>
        <textarea id="rm-reason" name="reason" rows={4} maxLength={1000}
          aria-invalid={Boolean(err.reason)} />
        {err.reason && <span role="alert">{err.reason}</span>}
        <small className="text-muted">You don&rsquo;t have to give a reason.</small>
      </p>

      <TurnstileWidget siteKey={turnstileSiteKey} resetOn={state} />

      {state.status === "error" && state.message && (
        <p role="alert" data-testid="removal-error">{state.message}</p>
      )}

      <button type="submit" disabled={pending} className="btn btn-primary">
        {pending ? "Sending…" : "Request removal"}
      </button>
    </form>
  );
}
