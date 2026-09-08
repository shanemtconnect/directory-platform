"use client";

import { useEffect } from "react";
import { siteConfig } from "@/config/site.config";
import { suppressFooterMatrix } from "@/components/layout/footer-matrix-flag";

/**
 * The recoverable error boundary. Rendered inside the root layout, so a visitor
 * who hits a failed query still has the header, the footer and a way onwards
 * rather than a blank page.
 *
 * `error.message` is never shown. In production Next replaces it with a digest
 * anyway, but in development it is a stack trace, and a screenshot of one is
 * how internal detail ends up in a support inbox. The digest is enough to find
 * the request in the logs, so that is what is offered.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("route error", error);
  }, [error]);

  const e = siteConfig.entity;
  // See footer-matrix-flag.ts. Reliable for an error thrown during the
  // initial server render, which is the case that matters most — this file
  // still runs as a plain function on the server for that request, same as
  // any other component in the tree.
  suppressFooterMatrix();

  return (
    <main>
      <div className="prose py-6">
        <p className="font-heading text-sm font-semibold tracking-widest text-muted uppercase">
          Something went wrong
        </p>
        <h1 className="mt-2">This page didn&rsquo;t load</h1>
        <p className="text-lg text-muted">
          The fault is at our end, not yours. Trying again often works — the {e.plural}{" "}
          themselves are fine.
        </p>

        <p className="mt-6 flex flex-wrap gap-3">
          <button type="button" onClick={reset} className="btn btn-primary">
            Try again
          </button>
          <a href="/" className="btn btn-secondary">
            Go to the homepage
          </a>
        </p>

        <h2>Or start somewhere else</h2>
        <ul>
          <li>
            <a href="/cities">Browse by location</a>
          </li>
          <li>
            <a href="/categories">Browse {e.plural} by type</a>
          </li>
          <li>
            <a href="/search">Search {e.plural}</a>
          </li>
        </ul>

        <p className="mt-8 text-sm text-muted">
          If it keeps happening, email{" "}
          <a href={`mailto:${siteConfig.supportEmail}`}>{siteConfig.supportEmail}</a>
          {error.digest ? (
            <>
              {" "}
              and quote reference <code data-testid="error-digest">{error.digest}</code>, which
              is how we find this exact request in our logs.
            </>
          ) : (
            "."
          )}
        </p>
      </div>
    </main>
  );
}
