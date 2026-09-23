"use client";

import { useActionState, useState } from "react";
import { siteConfig } from "@/config/site.config";
import { postJob, type PostJobState } from "@/lib/actions/jobs";
import type { PosterListing } from "@/lib/db/queries/job-board";
import { JOB_DESCRIPTION_MAX, JOB_DESCRIPTION_MIN, JOB_TITLE_MAX } from "@/lib/jobs/validate";
import { TurnstileWidget } from "@/components/submit/TurnstileWidget";
import { Notice } from "@/components/ui/Notice";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { formatJobPrice } from "./format";

const initial: PostJobState = { status: "idle" };

export interface PostJobFormProps {
  cities: { id: string; name: string; region: string | null }[];
  categories: { id: string; name: string }[];
  /** The signed-in poster's listings; empty for a stranger. */
  listings: PosterListing[];
  signedIn: boolean;
  /** False when the configured price is zero: no payment step exists. */
  charges: boolean;
  turnstileSiteKey: string | null;
}

/**
 * One form for both posters. A Verified owner picks the listing to post on
 * behalf of and pays nothing; everyone else sees the price and, if they own
 * a listing that is not Verified, the way to make the next one free.
 */
export function PostJobForm({ cities, categories, listings, signedIn, charges, turnstileSiteKey }: PostJobFormProps) {
  const [state, action, pending] = useActionState(postJob, initial);
  const [applyMethod, setApplyMethod] = useState<"email" | "url">("email");
  const e = siteConfig.entity;
  const err = state.fieldErrors ?? {};
  const verified = listings.filter((l) => l.verified);
  const unverified = listings.filter((l) => !l.verified);
  const [listingId, setListingId] = useState<string>(verified[0]?.id ?? "");
  const free = !charges || (verified.length > 0 && listingId !== "");
  const price = formatJobPrice();

  return (
    <form action={action} data-testid="post-job-form" className="max-w-2xl">
      <div aria-hidden="true" style={{ position: "absolute", left: "-9999px" }}>
        <label htmlFor="company_website">Leave this field empty</label>
        <input id="company_website" name="company_website" type="text" tabIndex={-1} autoComplete="off" />
      </div>

      {state.status === "error" && state.message && (
        <Notice variant="error" testId="post-job-error">
          {state.message}
        </Notice>
      )}

      <fieldset>
        <legend>Who is posting</legend>
        {verified.length > 0 ? (
          <p>
            <label htmlFor="pj-listing">Post on behalf of</label>
            <select
              id="pj-listing"
              name="listingId"
              value={listingId}
              onChange={(ev) => setListingId(ev.target.value)}
              aria-invalid={Boolean(err.listingId)}
              data-testid="post-job-listing"
            >
              {verified.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name} (Verified — free)
                </option>
              ))}
              {charges && <option value="">Somebody else — {price}</option>}
            </select>
            {err.listingId && <span role="alert">{err.listingId}</span>}
          </p>
        ) : (
          <input type="hidden" name="listingId" value="" />
        )}

        {free ? (
          <Notice variant="success" testId="post-job-free">
            {charges
              ? `This post is free: it is made on behalf of a Verified ${e.singular}.`
              : "Posting is free on this site."}
          </Notice>
        ) : (
          <Notice variant="status" testId="post-job-price" title={`This post costs ${price}`}>
            <p>
              One payment through PayPal, taken before the post goes to review. It stays live for{" "}
              {siteConfig.jobs.durationDays} days once approved.
            </p>
            <p className="mb-0" data-testid="post-job-upsell">
              {unverified.length > 0 ? (
                <>
                  Owners of a Verified {e.singular} post free.{" "}
                  <a href="/pricing">See the plans that include verification</a> for {unverified[0]?.name}.
                </>
              ) : signedIn ? (
                <>
                  Owners of a Verified {e.singular} post free. <a href="/pricing">See how to get verified.</a>
                </>
              ) : (
                <>
                  Own a Verified {e.singular} here? <a href="/login?next=/post-a-job">Sign in</a> to post free.
                </>
              )}
            </p>
          </Notice>
        )}
      </fieldset>

      <fieldset>
        <legend>The job</legend>
        <p>
          <label htmlFor="pj-title">Job title</label>
          <input id="pj-title" name="title" required minLength={5} maxLength={JOB_TITLE_MAX} aria-invalid={Boolean(err.title)} />
          {err.title && <span role="alert">{err.title}</span>}
        </p>
        <p>
          <label htmlFor="pj-company">Who is hiring</label>
          <input id="pj-company" name="companyName" required maxLength={120} aria-invalid={Boolean(err.companyName)} autoComplete="organization" />
          {err.companyName && <span role="alert">{err.companyName}</span>}
        </p>
        <p>
          <label htmlFor="pj-city">Town</label>
          <select id="pj-city" name="cityId" required defaultValue="" aria-invalid={Boolean(err.cityId)}>
            <option value="" disabled>Choose one</option>
            {cities.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.region ? ` (${c.region})` : ""}
              </option>
            ))}
          </select>
          {err.cityId && <span role="alert">{err.cityId}</span>}
        </p>
        <p>
          <label htmlFor="pj-category">Category</label>
          <select id="pj-category" name="categoryId" required defaultValue="" aria-invalid={Boolean(err.categoryId)}>
            <option value="" disabled>Choose one</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          {err.categoryId && <span role="alert">{err.categoryId}</span>}
        </p>
        <p>
          <label htmlFor="pj-description">About the role</label>
          <textarea
            id="pj-description"
            name="description"
            required
            minLength={JOB_DESCRIPTION_MIN}
            maxLength={JOB_DESCRIPTION_MAX}
            rows={8}
            aria-invalid={Boolean(err.description)}
            aria-describedby="pj-description-help"
          />
          <small id="pj-description-help">
            {JOB_DESCRIPTION_MIN} to {JOB_DESCRIPTION_MAX} characters. Say what the work is, when, and what you are looking for.
          </small>
          {err.description && <span role="alert">{err.description}</span>}
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <p>
            <label htmlFor="pj-budget-min">Pay from ({siteConfig.currency}, optional)</label>
            <input id="pj-budget-min" name="budgetMin" inputMode="decimal" aria-invalid={Boolean(err.budgetMin)} />
            {err.budgetMin && <span role="alert">{err.budgetMin}</span>}
          </p>
          <p>
            <label htmlFor="pj-budget-max">Pay to ({siteConfig.currency}, optional)</label>
            <input id="pj-budget-max" name="budgetMax" inputMode="decimal" aria-invalid={Boolean(err.budgetMax)} />
            {err.budgetMax && <span role="alert">{err.budgetMax}</span>}
          </p>
        </div>
      </fieldset>

      <fieldset>
        <legend>How to apply</legend>
        <p role="radiogroup" aria-labelledby="pj-apply-label">
          <span id="pj-apply-label" className="sr-only">How people apply</span>
          <label className="mr-4">
            <input type="radio" name="applyMethod" value="email" checked={applyMethod === "email"} onChange={() => setApplyMethod("email")} /> By email
          </label>
          <label>
            <input type="radio" name="applyMethod" value="url" checked={applyMethod === "url"} onChange={() => setApplyMethod("url")} /> On a web page
          </label>
          {err.applyMethod && <span role="alert">{err.applyMethod}</span>}
        </p>
        {applyMethod === "email" ? (
          <p>
            <label htmlFor="pj-apply-email">Send applications to</label>
            <input id="pj-apply-email" name="applyEmail" type="email" required aria-invalid={Boolean(err.applyEmail)} />
            {err.applyEmail && <span role="alert">{err.applyEmail}</span>}
          </p>
        ) : (
          <p>
            <label htmlFor="pj-apply-url">Application page</label>
            <input id="pj-apply-url" name="applyUrl" type="url" required placeholder="https://" aria-invalid={Boolean(err.applyUrl)} />
            {err.applyUrl && <span role="alert">{err.applyUrl}</span>}
          </p>
        )}
      </fieldset>

      <fieldset>
        <legend>About you</legend>
        <p>
          <label htmlFor="pj-poster-name">Your name</label>
          <input id="pj-poster-name" name="posterName" required maxLength={100} aria-invalid={Boolean(err.posterName)} autoComplete="name" />
          {err.posterName && <span role="alert">{err.posterName}</span>}
        </p>
        <p>
          <label htmlFor="pj-poster-email">Your email</label>
          <input id="pj-poster-email" name="posterEmail" type="email" required aria-invalid={Boolean(err.posterEmail)} autoComplete="email" aria-describedby="pj-poster-email-help" />
          <small id="pj-poster-email-help">We tell you when the post is approved and before it closes. Not shown on the site.</small>
          {err.posterEmail && <span role="alert">{err.posterEmail}</span>}
        </p>
      </fieldset>

      <TurnstileWidget siteKey={turnstileSiteKey} resetOn={state} />

      <p className="form-actions">
        <SubmitButton pending={pending} pendingLabel={free ? "Sending…" : "Taking you to PayPal…"} testId="post-job-submit">
          {free ? "Send for review" : `Pay ${price} and send for review`}
        </SubmitButton>
      </p>
    </form>
  );
}
