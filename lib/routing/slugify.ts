export function slugify(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip combining diacritics
    .replace(/['’]/g, "") // apostrophes vanish: "St Ouen's" -> "st-ouens"
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-") // everything else is a separator
    .replace(/^-+|-+$/g, "");
}

/**
 * Reserved at the root scope. Seeded into `slugs` as kind='static', so the
 * database rejects a colliding city or vertical rather than trusting
 * application code to remember.
 *
 * Includes every flagged route segment, not just the enabled ones: a city
 * called "Awards" must be rejected on a site where awards is off, or turning
 * the flag on later breaks a live URL.
 */
export const RESERVED_SLUGS = [
  "about", "account", "add-listing", "admin", "advertise", "api", "areas",
  "awards", "badge", "blog", "categories", "cities", "claim", "contact",
  "cost", "data-sources", "faq", "get-quotes", "guides", "images", "jobs",
  "leave-review", "page", "post-a-job", "pricing", "privacy", "robots", "safety",
  "search", "select-listing-type", "shortlist", "sitemap", "sitemaps", "terms",
  "tools", "trust", "_next",
  // Phases 3–7: every top-level route added since, including the ones behind
  // flags, so a city or category can never shadow /report, /checkout or /login.
  "checkout", "login", "signup", "logout", "forgot-password", "reset-password",
  "verify-email", "remove", "report", "review", "reviews", "billing",
  // Task 45: the public featured-spot leaderboard lives at /spots/<id>.
  "spots",
  // Wave G: the pay-per-lead board lives at /leads.
  "leads",
] as const;

const reservedSet = new Set<string>(RESERVED_SLUGS);

export function isReserved(slug: string): boolean {
  return reservedSet.has(slug.toLowerCase());
}
