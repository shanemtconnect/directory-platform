"use client";

import { useActionState } from "react";
import { siteConfig } from "@/config/site.config";
import { countryProfile } from "@/lib/geo/countries";
import { submitListing, type SubmitListingState } from "@/lib/actions/submit-listing";
import type { SubmissionFormValues } from "@/lib/actions/validation";
import { TierChoice } from "./TierChoice";
import { TurnstileWidget } from "./TurnstileWidget";

const initial: SubmitListingState = { status: "idle" };

export interface SubmitListingFormProps {
  categories: { id: string; name: string }[];
  regions: string[];
  turnstileSiteKey: string | null;
  /**
   * Starting values, e.g. from the URL import. Only ever defaults: every field
   * stays editable and nothing is submitted until the person presses Submit.
   * Read on mount, so a caller replacing them remounts the form (`key`).
   */
  initialValues?: Partial<SubmissionFormValues>;
}

export function SubmitListingForm({
  categories,
  regions,
  turnstileSiteKey,
  initialValues = {},
}: SubmitListingFormProps) {
  const [state, action, pending] = useActionState(submitListing, initial);
  const country = countryProfile(siteConfig.country);
  const e = siteConfig.entity;
  const err = state.fieldErrors ?? {};
  const init = initialValues;
  // A <select> whose default matches no option falls back to its first
  // enabled option — a region nobody chose. Only a real option is preselected.
  const pick = (options: string[], value: string | undefined): string =>
    options.find((o) => o.toLowerCase() === value?.trim().toLowerCase()) ?? "";

  // Already listed. Pointing at the existing page is better for everyone than
  // a second row: the business gets the page that already ranks, and we do not
  // have to merge duplicates later.
  if (state.status === "duplicate") {
    return (
      <div data-testid="submit-duplicate" role="status" className="card bg-raised max-w-2xl">
        <h2>This looks like it&rsquo;s already listed</h2>
        {state.existing ? (
          <>
            <p>
              We already hold a listing for <strong>{state.existing.name}</strong>. Have a look —
              if that is your business, get in touch and we will hand you the page it already
              has, with its history intact.
            </p>
            <p>
              <a href={state.existing.listingPath}>See the listing we hold</a>
            </p>
          </>
        ) : (
          <p>{state.message}</p>
        )}
        <p>
          <small>
            Not the same business? Email{" "}
            <a href={`mailto:${siteConfig.supportEmail}`}>{siteConfig.supportEmail}</a> and
            we&rsquo;ll add yours by hand.
          </small>
        </p>
      </div>
    );
  }

  return (
    <form action={action} data-testid="submit-listing-form" className="max-w-2xl">
      {/* Honeypot. Hidden from people and from screen readers, visible to bots. */}
      <div aria-hidden="true" style={{ position: "absolute", left: "-9999px" }}>
        <label htmlFor="company_website">Leave this field empty</label>
        <input id="company_website" name="company_website" type="text" tabIndex={-1} autoComplete="off" />
      </div>

      <fieldset>
        <legend>About the {e.singular}</legend>

        <p>
          <label htmlFor="sl-name">Business name</label>
          <input id="sl-name" name="name" required maxLength={200} defaultValue={init.name}
            aria-invalid={Boolean(err.name)} autoComplete="organization" />
          {err.name && <span role="alert">{err.name}</span>}
        </p>

        <p>
          <label htmlFor="sl-category">Category</label>
          <select id="sl-category" name="categoryId" required aria-invalid={Boolean(err.categoryId)}
            defaultValue={pick(categories.map((c) => c.id), init.categoryId)}>
            <option value="" disabled>Choose one</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          {err.categoryId && <span role="alert">{err.categoryId}</span>}
        </p>

        <p>
          <label htmlFor="sl-description">Description</label>
          <textarea id="sl-description" name="description" required minLength={50} maxLength={500}
            rows={6} aria-invalid={Boolean(err.description)} defaultValue={init.description}
            aria-describedby="sl-description-help" />
          <small id="sl-description-help">
            Between 50 and 500 characters, in your own words. Copy taken from somewhere else is
            rejected.
          </small>
          {err.description && <span role="alert">{err.description}</span>}
        </p>
      </fieldset>

      <fieldset>
        <legend>Where it is</legend>

        <p>
          <label htmlFor="sl-address">Street address</label>
          <input id="sl-address" name="addressLine1" required maxLength={200} defaultValue={init.addressLine1}
            aria-invalid={Boolean(err.addressLine1)} autoComplete="address-line1" />
          {err.addressLine1 && <span role="alert">{err.addressLine1}</span>}
        </p>

        <p>
          <label htmlFor="sl-region">{country.regionLabel[0]?.toUpperCase()}{country.regionLabel.slice(1)}</label>
          <select id="sl-region" name="region" required aria-invalid={Boolean(err.region)}
            defaultValue={pick(regions, init.region)} aria-describedby="sl-region-help">
            <option value="" disabled>Choose one</option>
            {regions.map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
          <small id="sl-region-help">
            Used to tell towns of the same name apart. It never appears in your web address,
            and if your town is new to us we check it ourselves rather than taking this one.
          </small>
          {err.region && <span role="alert">{err.region}</span>}
        </p>

        <p>
          <label htmlFor="sl-city">Town or city</label>
          <input id="sl-city" name="city" required maxLength={120} defaultValue={init.city}
            aria-invalid={Boolean(err.city)} autoComplete="address-level2"
            aria-describedby="sl-city-help" />
          <small id="sl-city-help">
            Type it in full. If we don&rsquo;t cover it yet we&rsquo;ll add it when we review this.
          </small>
          {err.city && <span role="alert">{err.city}</span>}
        </p>

        <p>
          <label htmlFor="sl-postcode">
            {country.postcodeLabel[0]?.toUpperCase()}{country.postcodeLabel.slice(1)}
          </label>
          <input id="sl-postcode" name="postcode" required maxLength={16} defaultValue={init.postcode}
            aria-invalid={Boolean(err.postcode)} autoComplete="postal-code"
            placeholder={country.postcodeExample} />
          {err.postcode && <span role="alert">{err.postcode}</span>}
        </p>
      </fieldset>

      <fieldset>
        <legend>How people reach it</legend>

        <p>
          <label htmlFor="sl-phone">Phone</label>
          <input id="sl-phone" name="phone" type="tel" required maxLength={40} defaultValue={init.phone}
            aria-invalid={Boolean(err.phone)} autoComplete="tel" />
          {err.phone && <span role="alert">{err.phone}</span>}
        </p>

        <p>
          <label htmlFor="sl-website">Website (optional)</label>
          <input id="sl-website" name="website" type="text" maxLength={300} defaultValue={init.website}
            aria-invalid={Boolean(err.website)} autoComplete="url"
            placeholder="example.co.uk" />
          {err.website && <span role="alert">{err.website}</span>}
        </p>
      </fieldset>

      <fieldset>
        <legend>About you</legend>

        <p>
          <label htmlFor="sl-your-name">Your name</label>
          <input id="sl-your-name" name="submitterName" required maxLength={120}
            defaultValue={init.submitterName}
            aria-invalid={Boolean(err.submitterName)} autoComplete="name" />
          {err.submitterName && <span role="alert">{err.submitterName}</span>}
        </p>

        <p>
          <label htmlFor="sl-your-email">Your email</label>
          <input id="sl-your-email" name="submitterEmail" type="email" required maxLength={254}
            defaultValue={init.submitterEmail}
            aria-invalid={Boolean(err.submitterEmail)} autoComplete="email"
            aria-describedby="sl-email-help" />
          <small id="sl-email-help">
            We use it to tell you the outcome. It is not published on the listing.
          </small>
          {err.submitterEmail && <span role="alert">{err.submitterEmail}</span>}
        </p>
      </fieldset>

      <TierChoice error={err.tier} />

      <TurnstileWidget siteKey={turnstileSiteKey} resetOn={state} />

      {state.status === "error" && state.message && (
        <p role="alert" data-testid="submit-error">{state.message}</p>
      )}

      <button type="submit" disabled={pending} className="btn btn-primary">
        {pending ? "Sending…" : "Submit listing"}
      </button>

      <p>
        <small>
          Nothing goes live until we&rsquo;ve checked it. We aim to review every submission
          within 24 hours. No account needed.
        </small>
      </p>
    </form>
  );
}
