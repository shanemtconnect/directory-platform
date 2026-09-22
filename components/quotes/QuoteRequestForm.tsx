"use client";

import { useActionState } from "react";
import { siteConfig } from "@/config/site.config";
import { submitQuoteRequest, type QuoteFormState } from "@/lib/actions/quotes";
import { QUOTE_MESSAGE_MAX, QUOTE_MESSAGE_MIN } from "@/lib/actions/quotes-validation";
import { TurnstileWidget } from "@/components/submit/TurnstileWidget";
import { Notice } from "@/components/ui/Notice";
import { SubmitButton } from "@/components/ui/SubmitButton";

const initial: QuoteFormState = { status: "idle" };

export interface QuoteOption {
  id: string;
  name: string;
}

export interface QuoteRequestFormProps {
  categories: QuoteOption[];
  towns: QuoteOption[];
  /** Null outside production; the server-side check skips in the same case. */
  turnstileSiteKey: string | null;
}

/**
 * The get-quotes form.
 *
 * Town and category are real `<select>`s fed from the database — the same
 * indexable towns the location switcher offers and the same categories the
 * index page lists — so the form can never name a place or a category the
 * site does not have. The consent box is not pre-ticked: the visitor is
 * handing their details to businesses they have not chosen, and that is
 * something a person says yes to, not something a form assumes.
 */
export function QuoteRequestForm({ categories, towns, turnstileSiteKey }: QuoteRequestFormProps) {
  const [state, action, pending] = useActionState(submitQuoteRequest, initial);
  const e = siteConfig.entity;

  if (state.status === "sent") {
    const n = state.recipientCount ?? 0;
    return (
      <Notice variant="success" testId="quote-sent" title={`Sent to ${n} ${n === 1 ? e.singular : e.plural}`}>
        <p className="mb-0">
          Your request has gone to {n} {n === 1 ? e.singular : e.plural} in the town you chose.
          Any that can help will reply to you directly — we&rsquo;ve emailed you a copy.
        </p>
      </Notice>
    );
  }

  const err = state.fieldErrors ?? {};

  return (
    <form action={action} data-testid="quote-form" className="card">
      {/* Honeypot. Hidden from people and from screen readers, visible to bots. */}
      <div aria-hidden="true" style={{ position: "absolute", left: "-9999px" }}>
        <label htmlFor="company_website">Leave this field empty</label>
        <input id="company_website" name="company_website" type="text" tabIndex={-1} autoComplete="off" />
      </div>

      <p>
        <label htmlFor="quote-category">What do you need?</label>
        <select id="quote-category" name="categoryId" required defaultValue="" aria-invalid={Boolean(err.categoryId)}>
          <option value="" disabled>Choose a category</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
        {err.categoryId && <span role="alert">{err.categoryId}</span>}
      </p>

      <p>
        <label htmlFor="quote-town">Where?</label>
        <select id="quote-town" name="cityId" required defaultValue="" aria-invalid={Boolean(err.cityId)}>
          <option value="" disabled>Choose a town</option>
          {towns.map((t) => (
            <option key={t.id} value={t.id}>{t.name}</option>
          ))}
        </select>
        {err.cityId && <span role="alert">{err.cityId}</span>}
      </p>

      <p>
        <label htmlFor="quote-message">Describe the job</label>
        <textarea
          id="quote-message"
          name="message"
          required
          minLength={QUOTE_MESSAGE_MIN}
          maxLength={QUOTE_MESSAGE_MAX}
          rows={6}
          aria-invalid={Boolean(err.message)}
          aria-describedby="quote-message-hint"
        />
        <small id="quote-message-hint" className="text-muted">
          Dates, numbers, budget if you have one — up to {QUOTE_MESSAGE_MAX} characters.
        </small>
        {err.message && <span role="alert">{err.message}</span>}
      </p>

      <p>
        <label htmlFor="quote-name">Your name</label>
        <input id="quote-name" name="name" required maxLength={120} autoComplete="name" aria-invalid={Boolean(err.name)} />
        {err.name && <span role="alert">{err.name}</span>}
      </p>

      <p>
        <label htmlFor="quote-email">Email</label>
        <input id="quote-email" name="email" type="email" required maxLength={254} autoComplete="email" aria-invalid={Boolean(err.email)} />
        {err.email && <span role="alert">{err.email}</span>}
      </p>

      <p>
        <label htmlFor="quote-phone">Phone (optional)</label>
        <input id="quote-phone" name="phone" type="tel" maxLength={40} autoComplete="tel" />
        {err.phone && <span role="alert">{err.phone}</span>}
      </p>

      <p>
        <label className="inline-flex items-start gap-2">
          <input id="quote-consent" name="consent" type="checkbox" required className="mt-1" aria-invalid={Boolean(err.consent)} />
          <span>
            Send my name, email and phone number to up to {siteConfig.quotes.maxRecipients}{" "}
            {e.plural} in this town so they can quote. We don&rsquo;t sell your details.
          </span>
        </label>
        {err.consent && <span role="alert">{err.consent}</span>}
      </p>

      <TurnstileWidget siteKey={turnstileSiteKey} resetOn={state} />

      {state.status === "error" && state.message && (
        <Notice variant="error" testId="quote-error">{state.message}</Notice>
      )}

      <SubmitButton pending={pending} pendingLabel="Sending…" block>
        Send my request
      </SubmitButton>
    </form>
  );
}
