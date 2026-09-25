"use client";

import { useState, useTransition } from "react";
import { useSession } from "@/lib/auth/client";
import { loginPath } from "@/lib/auth/next";
import { saveSearch } from "@/lib/actions/saved-searches";

/**
 * "Save this search" on /search and /jobs (Task 54). Mount it only where the
 * `savedSearches` flag is on — the page decides, on the server, because a
 * client bundle cannot see the build's flag override.
 *
 * Client-side off the session, like OwnerReplyForm: /jobs is ISR-cached for
 * everyone, so the page must not render per viewer. Signed out, it is a link
 * to sign in that comes back to this same search; signed in, one click saves
 * the page's own query params and it becomes "Saved — manage". The action
 * re-reads the viewer; this component is a convenience, not the gate.
 */
export function SaveSearchButton({
  kind, params, label, currentPath,
}: {
  kind: "listings" | "jobs";
  /** The page's query input, as the query takes it. Passed through untouched. */
  params: Record<string, unknown>;
  label: string;
  /** Site-relative URL of this search, for the sign-in round trip. */
  currentPath: string;
}) {
  const { data: session, isPending } = useSession();
  const [pending, start] = useTransition();
  const [saved, setSaved] = useState(false);
  const [signedOut, setSignedOut] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (isPending) return null;

  if (!session?.user || signedOut) {
    return (
      <a href={loginPath(currentPath)} className="btn btn-secondary" data-testid="save-search-login">
        Sign in to save this search
      </a>
    );
  }

  if (saved) {
    return (
      <p className="mb-0" role="status" data-testid="save-search-saved">
        Saved — <a href="/account/alerts">manage</a>
      </p>
    );
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button
        type="button"
        className="btn btn-secondary"
        data-testid="save-search"
        disabled={pending}
        onClick={() => {
          setError(null);
          start(async () => {
            const result = await saveSearch({ kind, params, label });
            if (result.ok) setSaved(true);
            else if (result.signIn) setSignedOut(true);
            else setError(result.message ?? "Please try again.");
          });
        }}
      >
        {pending ? "Saving…" : "Save this search"}
      </button>
      {error && <span role="alert" data-testid="save-search-error">{error}</span>}
    </span>
  );
}
