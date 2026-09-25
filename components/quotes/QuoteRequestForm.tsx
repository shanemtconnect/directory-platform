"use client";

import { useActionState } from "react";
import { siteConfig } from "@/config/site.config";
import { submitQuoteRequest, type QuoteFormState } from "@/lib/actions/quotes";
import { QUOTE_MESSAGE_MAX, QUOTE_MESSAGE_MIN } from "@/lib/actions/quotes-validation";
import { QUOTE_VERIFY_TTL_HOURS } from "@/lib/quotes/verify-ttl";
import { TurnstileWidget } from "@/components/submit/TurnstileWidget";
import { leadSharingNotice } from "@/lib/leads/consent";
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
  /**
   * `features.leadMarketplace`, passed from the server page: the flag is
   * resolved at build on the server, and the consent wording must match what
   * the site will actually do with the request.
   */
  leadMarketplace?: boolean;
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
export function QuoteRequestForm({ categories, towns, turnstileSiteKey, leadMarketplace = false }: QuoteRequestFormProps) {
  const [state, action, pending] = useActionState(submitQuoteRequest, initial);
  const e = siteConfig.entity;

  if (state.status === "sent") {
    const n = state.recipientCount ?? 0;
    // Nothing has gone anywhere yet: the requester's click on the emailed
    // link is what sends it (app/get-quotes/verify/[token]/confirm/route.ts).
    return (
      <Notice variant="success" testId="quote-sent" title="Check your email">
        <p className="mb-0">
          We&rsquo;ve emailed you a link to confirm your request. Click it within{" "}
          {QUOTE_VERIFY_TTL_HOURS} hours and{" "}
          {n > 0
            ? `we'll send it to ${n} ${n === 1 ? e.singular : e.plural} in the town you chose`
            : `we'll pass it on to ${e.plural} that can help`}
          . Nothing is sent to anyone until you do.
        </p>
      </Notice>
    );
  }

  const err = state.fieldErrors ?? {};
  const vals = state.values;
  // React only reads `defaultValue`/`defaultChecked` when a field FIRST
  // mounts — changing the prop on a later render of the same DOM node does
  // nothing, and the native reset React runs after a form action returns
  // (Task 60) restores whatever that first, mount-time default was. Keying
  // each field on what was actually submitted forces a remount exactly when
  // the server hands back different values, so the reset lands on the
  // person's own typing rather than on the field's original blank default.
  const valueKey = vals ? JSON.stringify(vals) : "initial";
  // The specific "no phone" refusal (lib/actions/quotes.ts) sets the phone
  // field's error to the exact same text as the notice, so this is the one
  // way to tell it apart from a plain "too long" or "check the fields"
  // refusal without a dedicated flag.
  const phoneNotice = state.status === "error" && err.phone && state.message === err.phone ? state.message : null;

  return (
    <form action={action} data-testid="quote-form" className="card">
      {/* Honeypot. Hidden from people and from screen readers, visible to bots. */}
      <div aria-hidden="true" style={{ position: "absolute", left: "-9999px" }}>
        <label htmlFor="company_website">Leave this field empty</label>
        <input id="company_website" name="company_website" type="text" tabIndex={-1} autoComplete="off" />
      </div>

      {phoneNotice && (
        <Notice variant="error" testId="quote-phone-notice">{phoneNotice}</Notice>
      )}

      <p>
        <label htmlFor="quote-category">What do you need?</label>
        <select key={valueKey} id="quote-category" name="categoryId" required defaultValue={vals?.categoryId ?? ""} aria-invalid={Boolean(err.categoryId)}>
          <option value="" disabled>Choose a category</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
        {err.categoryId && <span role="alert">{err.categoryId}</span>}
      </p>

      <p>
        <label htmlFor="quote-town">Where?</label>
        <select key={valueKey} id="quote-town" name="cityId" required defaultValue={vals?.cityId ?? ""} aria-invalid={Boolean(err.cityId)}>
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
          key={valueKey}
          id="quote-message"
          name="message"
          required
          minLength={QUOTE_MESSAGE_MIN}
          maxLength={QUOTE_MESSAGE_MAX}
          rows={6}
          defaultValue={vals?.message ?? ""}
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
        <input key={valueKey} id="quote-name" name="name" required maxLength={120} defaultValue={vals?.name ?? ""} autoComplete="name" aria-invalid={Boolean(err.name)} />
        {err.name && <span role="alert">{err.name}</span>}
      </p>

      <p>
        <label htmlFor="quote-email">Email</label>
        <input key={valueKey} id="quote-email" name="email" type="email" required maxLength={254} defaultValue={vals?.email ?? ""} autoComplete="email" aria-invalid={Boolean(err.email)} />
        {err.email && <span role="alert">{err.email}</span>}
      </p>

      <p>
        <label htmlFor="quote-phone">Phone (optional)</label>
        <input key={valueKey} id="quote-phone" name="phone" type="tel" maxLength={40} defaultValue={vals?.phone ?? ""} autoComplete="tel" aria-invalid={Boolean(err.phone)} />
        {leadMarketplace && (
          // With the lead marketplace on, a request nobody listed there can
          // take is passed on as a lead, and a lead needs a number to ring.
          <small className="text-muted">Needed if nobody listed in that town can take the request directly.</small>
        )}
        {err.phone && <span role="alert">{err.phone}</span>}
      </p>

      <p>
        <label className="inline-flex items-start gap-2">
          <input key={valueKey} id="quote-consent" name="consent" type="checkbox" required className="mt-1" defaultChecked={vals?.consent ?? false} aria-invalid={Boolean(err.consent)} />
          {leadMarketplace ? (
            <span>
              Send my name, email and phone number to up to {siteConfig.quotes.maxRecipients}{" "}
              {e.plural} in this town so they can quote. {leadSharingNotice()}
            </span>
          ) : (
            <span>
              Send my name, email and phone number to up to {siteConfig.quotes.maxRecipients}{" "}
              {e.plural} in this town so they can quote. We don&rsquo;t sell your details.
            </span>
          )}
        </label>
        {err.consent && <span role="alert">{err.consent}</span>}
      </p>

      <TurnstileWidget siteKey={turnstileSiteKey} resetOn={state} />

      {/* Already said once, above the form, when it's the "no phone" refusal —
          this generic slot is for every other error. */}
      {state.status === "error" && state.message && !phoneNotice && (
        <Notice variant="error" testId="quote-error">{state.message}</Notice>
      )}

      <SubmitButton pending={pending} pendingLabel="Sending…" block>
        Send my request
      </SubmitButton>
    </form>
  );
}
