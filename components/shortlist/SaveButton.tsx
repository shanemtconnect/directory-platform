"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { addToShortlist } from "@/lib/actions/shortlist";
import { siteConfig } from "@/config/site.config";

/**
 * The save control. Mount it anywhere a single listing is shown — a card, a
 * detail page, or a row of someone else's shared list.
 *
 * No sign-in prompt: the first click mints the cookie server-side and the save
 * just works. Asking an anonymous visitor to create an account before they can
 * keep track of three options is how a shortlist ends up unused.
 */
export function SaveButton({
  listingId, listingName, savedLabel = "Saved",
}: { listingId: string; listingName: string; savedLabel?: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const e = siteConfig.entity;

  if (saved) {
    return <span data-testid="shortlist-saved" role="status">{savedLabel}</span>;
  }

  return (
    <>
      <button
        type="button"
        data-testid="shortlist-save"
        data-listing-id={listingId}
        disabled={pending}
        onClick={() => {
          setError(null);
          start(async () => {
            const result = await addToShortlist(listingId);
            if (result.ok) {
              setSaved(true);
              router.refresh();
            } else {
              setError(result.message ?? "Please try again.");
            }
          });
        }}
      >
        {/*
          The accessible name is built from the visible text plus a hidden
          suffix, not an aria-label. An aria-label that does not begin with
          the words on the button ("Save The Mill to your shortlist" over
          "Save this …") fails WCAG 2.5.3 label-in-name: voice-control
          users say what they can see, and the name has to start with it.
        */}
        {pending ? (
          "Saving…"
        ) : (
          <>
            Save this {e.singular}
            <span className="sr-only">, {listingName}, to your shortlist</span>
          </>
        )}
      </button>
      {error && <span role="alert" data-testid="shortlist-save-error">{error}</span>}
    </>
  );
}
