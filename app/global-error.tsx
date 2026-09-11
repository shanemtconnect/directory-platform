"use client";

import { useEffect } from "react";
import { siteConfig } from "@/config/site.config";
import { clientSentryDsn } from "@/lib/observability/sentry";

/**
 * The last resort: this replaces the root layout, so there is no header, no
 * footer and no globals.css here.
 *
 * Everything is inline. A stylesheet is a second request that can fail for the
 * same reason the layout just did, and this page exists precisely for the case
 * where the layout itself threw — a page that depends on the thing that broke
 * is not a fallback. The one import is site.config.ts, a plain object with no
 * runtime dependencies of its own.
 *
 * The Sentry report below is the one exception, and it keeps that invariant:
 * the SDK is imported dynamically, inside an effect, after the markup has
 * rendered. If the import fails the visitor still sees this page — the
 * reporting is best-effort, the fallback is not. The static import is the
 * DSN check, which is a string comparison compiled from an inlined constant.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // React error boundaries swallow the errors they catch, so nothing here
    // reaches `window.onerror` and Sentry's global handlers never see it. This
    // is the only way a render failure this bad gets reported at all.
    if (clientSentryDsn() === undefined) return;
    void import("@sentry/nextjs")
      .then((Sentry) => Sentry.captureException(error))
      .catch(() => {});
  }, [error]);

  return (
    <html lang={siteConfig.locale}>
      <body
        style={{
          margin: 0,
          minHeight: "100dvh",
          display: "grid",
          placeItems: "center",
          padding: "2rem 1rem",
          background: "#faf8f5",
          color: "#1c1917",
          fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif",
          lineHeight: 1.6,
        }}
      >
        <main style={{ maxWidth: "36rem" }}>
          <h1 style={{ fontSize: "1.875rem", lineHeight: 1.2, margin: "0 0 0.75rem" }}>
            {siteConfig.name} is temporarily unavailable
          </h1>
          <p style={{ margin: "0 0 1.5rem", color: "#57534e" }}>
            Something failed badly enough that we couldn&rsquo;t render the page around it.
            Reloading usually clears it.
          </p>

          <p style={{ display: "flex", flexWrap: "wrap", gap: "0.75rem", margin: "0 0 1.5rem" }}>
            <button
              type="button"
              onClick={reset}
              style={{
                minHeight: "2.75rem",
                padding: "0.625rem 1.25rem",
                border: "1px solid #1c1917",
                borderRadius: "0.5rem",
                background: "#1c1917",
                color: "#ffffff",
                font: "inherit",
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Reload
            </button>
            <a
              href="/"
              style={{
                display: "inline-flex",
                alignItems: "center",
                minHeight: "2.75rem",
                padding: "0.625rem 1.25rem",
                border: "1px solid #e5ded5",
                borderRadius: "0.5rem",
                background: "#ffffff",
                color: "#1c1917",
                fontWeight: 600,
                textDecoration: "none",
              }}
            >
              Homepage
            </a>
          </p>

          <p style={{ margin: 0, fontSize: "0.875rem", color: "#57534e" }}>
            Still broken? Email{" "}
            <a href={`mailto:${siteConfig.supportEmail}`} style={{ color: "#1c1917" }}>
              {siteConfig.supportEmail}
            </a>
            {error.digest ? <> quoting reference {error.digest}.</> : "."}
          </p>
        </main>
      </body>
    </html>
  );
}
