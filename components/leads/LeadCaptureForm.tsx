"use client";

import { useActionState, useState } from "react";
import { siteConfig } from "@/config/site.config";
import { submitCaptureLead, type LeadCaptureState } from "@/lib/actions/lead-capture";
import { QUOTE_MESSAGE_MAX, QUOTE_MESSAGE_MIN } from "@/lib/actions/quotes-validation";
import { QUOTE_VERIFY_TTL_HOURS } from "@/lib/quotes/verify-ttl";
import { TurnstileWidget } from "@/components/submit/TurnstileWidget";
import { Notice } from "@/components/ui/Notice";
import { SubmitButton } from "@/components/ui/SubmitButton";

const initial: LeadCaptureState = { status: "idle" };

export interface LeadCaptureOption {
  id: string;
  name: string;
}

export interface LeadCaptureFormProps {
  categories: LeadCaptureOption[];
  towns: LeadCaptureOption[];
  turnstileSiteKey: string | null;
  /** Prefixes every id, so two boxes on one page could never collide. */
  idPrefix: string;
}

/**
 * The capture box's form: category, town, a line about the job, name, email
 * and phone. Short on purpose — it sits below the fold on the home page and
 * in a rail — and honest about what happens: the requester confirms by
 * email, and their details go to one local business that pays for them.
 */
export function LeadCaptureForm({ categories, towns, turnstileSiteKey, idPrefix }: LeadCaptureFormProps) {
  const [state, action, pending] = useActionState(submitCaptureLead, initial);
  // The challenge script is Cloudflare's, so it is not fetched until the
  // visitor starts on the form. The box sits on the home page and on every
  // railed page, and most visitors never touch it: they should not load a
  // third-party script for it (e2e/stats.spec.ts holds pages to that).
  const [engaged, setEngaged] = useState(false);
  const e = siteConfig.entity;
  const id = (name: string) => `${idPrefix}-${name}`;

  if (state.status === "sent") {
    return (
      <Notice variant="success" testId="lead-capture-sent" title="Check your email">
        <p className="mb-0">
          We&rsquo;ve emailed you a link to confirm your request. Click it within {QUOTE_VERIFY_TTL_HOURS} hours
          and we&rsquo;ll pass it to a {e.singular} that can help. Nothing is sent until you do.
        </p>
      </Notice>
    );
  }

  const err = state.fieldErrors ?? {};

  return (
    <form
      action={action}
      data-testid="lead-capture-form"
      onFocusCapture={() => setEngaged(true)}
      onInputCapture={() => setEngaged(true)}
      onPointerDownCapture={() => setEngaged(true)}
    >
      <div aria-hidden="true" style={{ position: "absolute", left: "-9999px" }}>
        <label htmlFor={id("company_website")}>Leave this field empty</label>
        <input id={id("company_website")} name="company_website" type="text" tabIndex={-1} autoComplete="off" />
      </div>

      <p>
        <label htmlFor={id("category")}>What do you need?</label>
        <select id={id("category")} name="categoryId" required defaultValue="" aria-invalid={Boolean(err.categoryId)}>
          <option value="" disabled>Choose a category</option>
          {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        {err.categoryId && <span role="alert">{err.categoryId}</span>}
      </p>

      <p>
        <label htmlFor={id("town")}>Where?</label>
        <select id={id("town")} name="cityId" required defaultValue="" aria-invalid={Boolean(err.cityId)}>
          <option value="" disabled>Choose a town</option>
          {towns.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        {err.cityId && <span role="alert">{err.cityId}</span>}
      </p>

      <p>
        <label htmlFor={id("message")}>The job, in a line or two</label>
        <textarea
          id={id("message")} name="message" required rows={3}
          minLength={QUOTE_MESSAGE_MIN} maxLength={QUOTE_MESSAGE_MAX} aria-invalid={Boolean(err.message)}
        />
        {err.message && <span role="alert">{err.message}</span>}
      </p>

      <p>
        <label htmlFor={id("name")}>Your name</label>
        <input id={id("name")} name="name" required maxLength={120} autoComplete="name" aria-invalid={Boolean(err.name)} />
        {err.name && <span role="alert">{err.name}</span>}
      </p>

      <p>
        <label htmlFor={id("email")}>Email</label>
        <input id={id("email")} name="email" type="email" required maxLength={254} autoComplete="email" aria-invalid={Boolean(err.email)} />
        {err.email && <span role="alert">{err.email}</span>}
      </p>

      <p>
        <label htmlFor={id("phone")}>Phone</label>
        <input id={id("phone")} name="phone" type="tel" required maxLength={40} autoComplete="tel" aria-invalid={Boolean(err.phone)} />
        {err.phone && <span role="alert">{err.phone}</span>}
      </p>

      <p>
        <label className="inline-flex items-start gap-2">
          <input id={id("consent")} name="consent" type="checkbox" required className="mt-1" aria-invalid={Boolean(err.consent)} />
          <span>
            Pass my request and contact details to a local {e.singular} that can help. They pay us
            for the introduction; I never pay anything.
          </span>
        </label>
        {err.consent && <span role="alert">{err.consent}</span>}
      </p>

      {engaged && <TurnstileWidget siteKey={turnstileSiteKey} resetOn={state} />}

      {state.status === "error" && state.message && (
        <Notice variant="error" testId="lead-capture-error">{state.message}</Notice>
      )}

      <SubmitButton pending={pending} pendingLabel="Sending…" block>
        Find me a {e.singular}
      </SubmitButton>
    </form>
  );
}
