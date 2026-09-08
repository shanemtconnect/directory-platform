"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { removeFromShortlist } from "@/lib/actions/shortlist";

/**
 * One button per saved row. A transition rather than a form so the table does
 * not flash through an empty state while the server round-trips.
 */
export function RemoveButton({
  listingId, listingName,
}: { listingId: string; listingName: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <>
      <button
        type="button"
        data-testid="shortlist-remove"
        data-listing-id={listingId}
        disabled={pending}
        aria-label={`Remove ${listingName} from your shortlist`}
        onClick={() => {
          setError(null);
          start(async () => {
            const result = await removeFromShortlist(listingId);
            if (!result.ok) setError(result.message ?? "Please try again.");
            else router.refresh();
          });
        }}
      >
        {pending ? "Removing…" : "Remove"}
      </button>
      {error && <span role="alert">{error}</span>}
    </>
  );
}
