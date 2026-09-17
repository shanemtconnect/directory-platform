"use client";

import { useActionState } from "react";
import { requestClaimLink, type DomainClaimState } from "@/lib/actions/claim";

const initial: DomainClaimState = { status: "idle" };

export interface DomainClaimFormProps {
  listingId: string;
  /** The domain the listing advertises, shown so the rule is not a guessing game. */
  domain: string;
}

export function DomainClaimForm({ listingId, domain }: DomainClaimFormProps) {
  const [state, action, pending] = useActionState(requestClaimLink, initial);

  if (state.status === "sent") {
    return (
      <div data-testid="claim-link-sent" role="status" className="card bg-raised">
        <h2 className="mt-0">Check that inbox</h2>
        <p>
          We&rsquo;ve emailed a confirmation link to{" "}
          <strong>{state.sentTo}</strong>. Open it within 30 minutes and the listing is yours.
        </p>
      </div>
    );
  }

  return (
    <form action={action} data-testid="claim-domain-form" className="card">
      <h2 className="mt-0 text-[length:var(--text-h3)]">Confirm by email</h2>
      <p className="text-muted">
        Fastest route. Use any address at <strong>{domain}</strong> and we&rsquo;ll send you a
        link — no waiting for a person.
      </p>
      <input type="hidden" name="listingId" value={listingId} />

      <p>
        <label htmlFor="claim-email">Your email at {domain}</label>
        <input
          id="claim-email" name="businessEmail" type="email" required maxLength={254}
          autoComplete="email" aria-invalid={Boolean(state.fieldErrors?.businessEmail)}
        />
        {state.fieldErrors?.businessEmail && (
          <span role="alert" data-testid="claim-email-error">{state.fieldErrors.businessEmail}</span>
        )}
      </p>

      <p>
        <label htmlFor="claim-name">Your name (optional)</label>
        <input id="claim-name" name="claimantName" maxLength={120} autoComplete="name" />
      </p>

      <p>
        <label htmlFor="claim-role">Your role (optional)</label>
        <input id="claim-role" name="roleAtBusiness" maxLength={120} />
      </p>

      {state.message && <p role="alert" data-testid="claim-error">{state.message}</p>}

      <button type="submit" disabled={pending} className="btn btn-primary w-full">
        {pending ? "Sending…" : "Email me the link"}
      </button>
    </form>
  );
}
