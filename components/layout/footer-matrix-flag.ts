import { cache } from "react";

/**
 * Lets `app/not-found.tsx` and `app/error.tsx` tell `SiteFooter` to skip the
 * city/category link matrix, without turning `SiteFooter` into a client
 * component or threading a prop through the root layout.
 *
 * The root layout renders `<SiteHeader />`, `{children}`, then `<SiteFooter />`
 * — in that order, on every route, including the two special-case pages. The
 * matrix (~360 links, one block per category) exists to give a real page crawl
 * depth into the taxonomy; on a 404 or an error boundary, that page **is** the
 * dead end the matrix is supposed to route a visitor away from, so it has
 * nothing to offer there and only adds weight.
 *
 * `cache()` gives every component within one request the same object, which is
 * what turns it into a request-scoped flag: whichever special page renders
 * sets `suppressed` before `SiteFooter` — declared after `{children}` in
 * `app/layout.tsx`, so it always renders later in the same pass — reads it.
 */
const getFlagBox = cache((): { suppressed: boolean } => ({ suppressed: false }));

export function suppressFooterMatrix(): void {
  getFlagBox().suppressed = true;
}

export function isFooterMatrixSuppressed(): boolean {
  return getFlagBox().suppressed;
}
