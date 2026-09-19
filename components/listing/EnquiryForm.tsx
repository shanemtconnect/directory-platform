"use client";

import { useActionState } from "react";
import { submitEnquiry, type EnquiryState } from "@/lib/actions/enquiry";
import { siteConfig } from "@/config/site.config";
import { TurnstileWidget } from "@/components/submit/TurnstileWidget";

const initial: EnquiryState = { status: "idle" };

export interface EnquiryFormProps {
  listingId: string;
  listingName: string;
  /** Null outside production; the server-side check skips in the same case. */
  turnstileSiteKey: string | null;
}

export function EnquiryForm({ listingId, listingName, turnstileSiteKey }: EnquiryFormProps) {
  const [state, action, pending] = useActionState(submitEnquiry, initial);

  if (state.status === "sent") {
    return (
      <div id="enquire" data-testid="enquiry-sent" role="status" className="card bg-raised">
        <h2 className="mt-0">Enquiry sent</h2>
        <p>Your message has gone to {listingName}. They&rsquo;ll reply to you directly.</p>
      </div>
    );
  }

  return (
    <form id="enquire" action={action} data-testid="enquiry-form" className="card">
      <h2 className="mt-0 text-[length:var(--text-h3)]">Enquire with {listingName}</h2>
      <input type="hidden" name="listingId" value={listingId} />

      {/* Honeypot. Hidden from people and from screen readers, visible to bots. */}
      <div aria-hidden="true" style={{ position: "absolute", left: "-9999px" }}>
        <label htmlFor="company_website">Leave this field empty</label>
        <input id="company_website" name="company_website" type="text" tabIndex={-1} autoComplete="off" />
      </div>

      <p>
        <label htmlFor="enq-name">Your name</label>
        <input id="enq-name" name="name" required maxLength={120}
          aria-invalid={Boolean(state.fieldErrors?.name)} autoComplete="name" />
        {state.fieldErrors?.name && <span role="alert">{state.fieldErrors.name}</span>}
      </p>

      <p>
        <label htmlFor="enq-email">Email</label>
        <input id="enq-email" name="email" type="email" required maxLength={254}
          aria-invalid={Boolean(state.fieldErrors?.email)} autoComplete="email" />
        {state.fieldErrors?.email && <span role="alert">{state.fieldErrors.email}</span>}
      </p>

      <p>
        <label htmlFor="enq-phone">Phone (optional)</label>
        <input id="enq-phone" name="phone" type="tel" maxLength={40} autoComplete="tel" />
      </p>

      <p>
        <label htmlFor="enq-message">Message</label>
        <textarea id="enq-message" name="message" required minLength={10} maxLength={2000} rows={5}
          aria-invalid={Boolean(state.fieldErrors?.message)} />
        {state.fieldErrors?.message && <span role="alert">{state.fieldErrors.message}</span>}
      </p>

      {/* Without this the action rejects every enquiry the moment a secret is
          configured: submitEnquiry requires a token it was never sent. */}
      <TurnstileWidget siteKey={turnstileSiteKey} resetOn={state} />

      {state.status === "error" && state.message && (
        <p role="alert" data-testid="enquiry-error">{state.message}</p>
      )}

      <button type="submit" disabled={pending} className="btn btn-primary w-full">
        {pending ? "Sending…" : "Send enquiry"}
      </button>

      <p className="mt-3 mb-0">
        <small>
          Your message goes straight to the {siteConfig.entity.ownerNoun}. We don&rsquo;t sell your details.
        </small>
      </p>
    </form>
  );
}
