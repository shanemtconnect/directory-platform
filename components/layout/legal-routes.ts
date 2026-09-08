/**
 * The legal pages, in the order they belong in a footer.
 *
 * Separate from `lib/features/navigation.ts` because these two are not
 * features: no flag turns them off, and a site that ships without a privacy
 * policy is not a smaller site, it is a broken one. `buildRoutes` still lists
 * them so the sitemap and the route-existence test see them; this is the list
 * the footer renders.
 */
export interface LegalRoute {
  readonly href: string;
  readonly label: string;
}

export const LEGAL_ROUTES: readonly LegalRoute[] = [
  { href: "/privacy", label: "Privacy" },
  { href: "/terms", label: "Terms" },
];
