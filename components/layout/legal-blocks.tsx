import type { ReactNode } from "react";
import { siteConfig } from "@/config/site.config";
import { formatDate as formatDateInLocale } from "@/lib/blog/posts";

/**
 * Shared between app/privacy/page.tsx and app/terms/page.tsx — both are
 * templates under the same rule: a clone-specific legal decision is marked
 * rather than asserted, and a draft notice says so up front. See either
 * page's own doc comment for why.
 */

/** A clone-specific decision this repo must not make on anyone's behalf. */
export function Confirm({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-[var(--radius-token)] border border-dashed border-line bg-raised p-4 text-sm">
      <strong>[Confirm with counsel]</strong> {children}
    </p>
  );
}

export function Draft({ children }: { children: ReactNode }) {
  return (
    <p
      role="note"
      className="rounded-[var(--radius-token)] border-l-4 border-accent bg-raised p-4 text-sm"
    >
      <strong>Draft.</strong> {children}
    </p>
  );
}

/**
 * Long form, in the site's own locale — this is a date a reader may rely on.
 * lib/blog/posts.ts already has the same day/month/year, UTC-anchored format;
 * this just binds it to siteConfig.locale instead of asking every call site
 * to pass it.
 */
export function formatDate(iso: string): string {
  return formatDateInLocale(iso, siteConfig.locale);
}
