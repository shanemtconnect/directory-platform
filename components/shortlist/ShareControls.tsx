"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setPublic } from "@/lib/actions/shortlist";

/**
 * The share toggle and, once it is on, the link.
 *
 * Sharing is off until the visitor turns it on: the list is theirs, and a
 * shortlist can say a lot about what someone is planning and how much they
 * intend to spend. The share URL is only ever built for a list that is already
 * public — showing the link while it 404s would be worse than showing nothing.
 */
export function ShareControls({
  shareId, isPublic,
}: { shareId: string; isPublic: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [live, setLive] = useState(isPublic);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [origin, setOrigin] = useState("");

  // Read after mount: the server has no idea which host the visitor typed, and
  // guessing produces a hydration mismatch on every preview deployment.
  useEffect(() => setOrigin(window.location.origin), []);
  useEffect(() => setLive(isPublic), [isPublic]);

  const path = `/shortlist/${shareId}`;
  const url = `${origin}${path}`;

  return (
    <section data-testid="shortlist-share">
      <h2>Share this list</h2>

      <p>
        <label>
          <input
            type="checkbox"
            checked={live}
            disabled={pending}
            data-testid="shortlist-share-toggle"
            onChange={(ev) => {
              const next = ev.target.checked;
              setError(null);
              setCopied(false);
              setLive(next);
              start(async () => {
                const result = await setPublic(next);
                if (!result.ok) {
                  setLive(!next);
                  setError(result.message ?? "Please try again.");
                } else {
                  router.refresh();
                }
              });
            }}
          />{" "}
          Anyone with the link can see this list
        </label>
      </p>

      {error && <p role="alert">{error}</p>}

      {live ? (
        <p data-testid="shortlist-share-link">
          <label htmlFor="shortlist-share-url">Link</label>{" "}
          <input id="shortlist-share-url" type="text" readOnly value={url || path} size={48}
            onFocus={(ev) => ev.currentTarget.select()} />{" "}
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard?.writeText(url || path).then(
                () => setCopied(true),
                () => setCopied(false),
              );
            }}
          >
            Copy
          </button>
          {copied && <span role="status"> Copied</span>}
        </p>
      ) : (
        <p>The link stays private until you turn this on.</p>
      )}
    </section>
  );
}
