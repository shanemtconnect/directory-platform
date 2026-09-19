/**
 * Plausible, or nothing.
 *
 * Why this analytics script and not the usual one: Plausible sets no cookies
 * and stores no personal data, so under the UK GDPR / Jersey DP Law it needs no
 * consent banner and no legitimate-interest assessment — which means the site
 * can measure its traffic without a modal in front of every first visit and
 * without a lawyer. `config/site.config.ts` `legal.dataController` therefore
 * has nothing to declare for it. Adding a script that DOES set cookies means
 * adding a consent gate in front of it; do not swap this out casually.
 *
 * The hosted script only. A self-hosted Plausible serves the same file from its
 * own origin, so supporting one is a second environment variable and a second
 * thing to get wrong; add it when a clone actually self-hosts.
 */

const clean = (v: string | undefined): string | undefined => {
  const trimmed = v?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
};

/**
 * The site the stats belong to, as registered in Plausible — which is a bare
 * hostname (`example.co.uk`), not a URL. A value with a scheme or a path is
 * silently ignored by Plausible's API, so it is rejected here instead: a clone
 * that pastes its `NEXT_PUBLIC_SITE_URL` in by mistake gets no script rather
 * than a script that reports nothing to nowhere for six months.
 *
 * The argument is the value, not an environment record, because
 * `next build` only substitutes the literal `process.env.NEXT_PUBLIC_*`
 * expression in the source text — see lib/observability/sentry.ts for the full
 * version of that trap.
 */
export function plausibleDomain(
  raw: string | undefined = process.env.NEXT_PUBLIC_PLAUSIBLE_DOMAIN,
): string | undefined {
  const domain = clean(raw);
  if (domain === undefined) return undefined;
  if (/[\s/:?#]/.test(domain)) return undefined;
  return domain;
}

export const PLAUSIBLE_SCRIPT_SRC = "https://plausible.io/js/script.js";
