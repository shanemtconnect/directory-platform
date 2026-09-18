"use client";

import { useActionState } from "react";
import { registerBacklinkAction, type BacklinkFormState } from "@/lib/actions/badge";

const initial: BacklinkFormState = { status: "idle" };

export interface BacklinkFormProps {
  listingId: string;
  /** What is registered today, or null when the owner has not said yet. */
  currentUrl: string | null;
  /** The domain the page has to be on, or null when the listing has no website. */
  expectedDomain: string | null;
}

/**
 * "Where did you put the badge?"
 *
 * One field, because that is all there is to say. The URL has to be on the
 * listing's own site, and the form says so up front rather than letting the
 * owner find out from the error: a badge on somebody else's page is not the
 * business linking to its listing.
 *
 * "Check now" is a second form posting the SAME URL to the same action — the
 * query treats that as "make it due again", so the hourly worker looks at the
 * page on its next run instead of in a week.
 */
export function BacklinkForm({ listingId, currentUrl, expectedDomain }: BacklinkFormProps) {
  const [state, action, pending] = useActionState(registerBacklinkAction, initial);

  return (
    <div className="card max-w-xl">
      <form action={action} data-testid="backlink-form">
        <input type="hidden" name="listingId" value={listingId} />
        <p>
          <label htmlFor="backlink-url">Where did you put the badge?</label>
          <input
            id="backlink-url"
            name="url"
            type="url"
            inputMode="url"
            defaultValue={currentUrl ?? ""}
            placeholder={expectedDomain ? `https://${expectedDomain}/…` : "https://…"}
            required
            maxLength={2048}
            aria-describedby="backlink-url-help"
          />
          <small id="backlink-url-help">
            The full address of the page on your own site that carries it
            {expectedDomain ? <> — somewhere on <strong>{expectedDomain}</strong></> : null}.
            We check it within the hour, and again every week while the link stays up.
          </small>
        </p>
        <p>
          <button type="submit" disabled={pending}>
            {pending ? "Saving…" : currentUrl ? "Update" : "Save"}
          </button>
        </p>
        {state.status === "saved" && (
          <p role="status" data-testid="backlink-saved">
            Saved. We will look for the link at <code>{state.url}</code> within the hour.
          </p>
        )}
        {state.status === "error" && state.message && (
          <p role="alert" data-testid="backlink-error">
            {state.message}
          </p>
        )}
      </form>

      {currentUrl && (
        <form action={action} data-testid="backlink-check-now" className="mt-2">
          <input type="hidden" name="listingId" value={listingId} />
          {/* The URL just saved, not the server prop: a click before the RSC
              refresh lands would otherwise re-post the previous URL and
              un-verify what was just registered. */}
          <input type="hidden" name="url" value={state.url ?? currentUrl} />
          <button type="submit" disabled={pending} className="text-sm">
            Check now
          </button>
          <small className="ml-2 text-neutral-600">
            Puts the page back in the queue for the next hourly check.
          </small>
        </form>
      )}
    </div>
  );
}
