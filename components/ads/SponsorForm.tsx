"use client";

import { useActionState } from "react";
import { createSponsorCampaignAction, type SponsorFormState } from "@/lib/actions/sponsor";
import { Notice } from "@/components/ui/Notice";
import { SubmitButton } from "@/components/ui/SubmitButton";

const initial: SponsorFormState = { status: "idle" };

export interface SponsorFormProps {
  /** `{ key, label }` for every placement the advertiser may pick. */
  placements: readonly { key: string; label: string }[];
  /** What happens after submit: PayPal, or nothing yet. */
  paymentLabel: string;
  titleMax: number;
  blurbMax: number;
  logoEnabled: boolean;
}

export function SponsorForm({ placements, paymentLabel, titleMax, blurbMax, logoEnabled }: SponsorFormProps) {
  const [state, action, pending] = useActionState(createSponsorCampaignAction, initial);
  const invalid = (field: string) => state.status === "error" && state.field === field;

  if (state.status === "submitted") {
    return (
      <Notice variant="success" testId="sponsor-submitted" title="Thanks — it is with us">
        Your campaign is in the queue. We check every sponsor by hand; you will get an email when it
        is live, or a reason if we cannot run it.
      </Notice>
    );
  }

  return (
    <form action={action} data-testid="sponsor-form" className="card max-w-xl" encType="multipart/form-data">
      {state.status === "error" && state.field === undefined && state.message !== undefined && (
        <Notice variant="error" testId="sponsor-error">{state.message}</Notice>
      )}

      <p>
        <label htmlFor="sponsor-name">Business name</label>
        <input id="sponsor-name" name="name" maxLength={80} required aria-invalid={invalid("name")} />
        {invalid("name") && <span role="alert">{state.message}</span>}
      </p>
      <p>
        <label htmlFor="sponsor-title">Headline <small>(up to {titleMax} characters)</small></label>
        <input id="sponsor-title" name="title" maxLength={titleMax} required aria-invalid={invalid("title")} />
        {invalid("title") && <span role="alert">{state.message}</span>}
      </p>
      <p>
        <label htmlFor="sponsor-blurb">Blurb <small>(up to {blurbMax} characters)</small></label>
        <textarea id="sponsor-blurb" name="blurb" maxLength={blurbMax} rows={3} required aria-invalid={invalid("blurb")} />
        {invalid("blurb") && <span role="alert">{state.message}</span>}
      </p>
      <p>
        <label htmlFor="sponsor-url">Where the card links to</label>
        <input id="sponsor-url" name="targetUrl" type="url" placeholder="https://" required aria-invalid={invalid("targetUrl")} />
        {invalid("targetUrl") && <span role="alert">{state.message}</span>}
      </p>
      {logoEnabled && (
        <p>
          <label htmlFor="sponsor-logo">Logo <small>(optional — JPEG, PNG or WebP, square works best)</small></label>
          <input id="sponsor-logo" name="logo" type="file" accept="image/jpeg,image/png,image/webp" aria-invalid={invalid("logo")} />
          {invalid("logo") && <span role="alert">{state.message}</span>}
        </p>
      )}

      <fieldset className="mb-4">
        <legend className="mb-1 text-sm font-semibold">Show it on</legend>
        {placements.map((p) => (
          <label key={p.key} className="mr-4 inline-flex min-h-11 items-center gap-2">
            <input type="checkbox" name="placements" value={p.key} defaultChecked />
            {p.label}
          </label>
        ))}
        {invalid("placements") && <span role="alert" className="block">{state.message}</span>}
      </fieldset>

      <p className="text-sm text-muted">{paymentLabel}</p>
      <SubmitButton pending={pending} pendingLabel="Sending…" testId="sponsor-submit">
        Submit for review
      </SubmitButton>
    </form>
  );
}
