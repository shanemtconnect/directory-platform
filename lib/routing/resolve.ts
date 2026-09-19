import { eq } from "drizzle-orm";
import { redirects } from "@/lib/db/schema";
import type { SiteMode } from "@/config/types";
import type { TestDb } from "@/lib/db/types";
import { resolveSlug, ROOT_SCOPE } from "./slugs";
import type { PillarScope } from "./scope";

export type RouteResolution =
  | { kind: "pillar"; scope: PillarScope; page: number }
  | { kind: "listing"; listingId: string; parentId: string }
  /** /[city]/[listing]/reviews — the only sub-page a listing has. */
  | { kind: "listing-reviews"; listingId: string; parentId: string; page: number }
  | { kind: "redirect"; to: string; status: number }
  | { kind: "not-found" };

/**
 * Lowercased on the way in: /Leeds and /leeds are the same URL, so they must
 * hit the same redirects row rather than one of them 404ing.
 */
async function redirectFor(tx: TestDb, path: string): Promise<RouteResolution | null> {
  const [r] = await tx
    .select()
    .from(redirects)
    .where(eq(redirects.fromPath, path.toLowerCase()))
    .limit(1);
  return r ? { kind: "redirect", to: r.toPath, status: r.statusCode } : null;
}

/**
 * A renamed city must not 404 everything underneath it.
 *
 * One redirects row for the city path carries the whole subtree — every listing
 * and category URL below it — without writing a row per child, which for a city
 * with 200 listings is the difference between one row and 201.
 */
async function rootPrefixRedirect(
  tx: TestDb,
  segments: string[],
): Promise<RouteResolution | null> {
  const first = segments[0];
  // A single segment is the exact lookup the caller already tried.
  if (first === undefined || segments.length < 2) return null;

  const target = await redirectFor(tx, `/${first}`);
  if (target === null || target.kind !== "redirect") return null;

  // A 410 row points at itself, so rebuilding a child path under it would
  // redirect /gone/thing straight back to /gone/thing. The subtree of a gone
  // city is gone too.
  if (target.status === 410) return target;

  return {
    kind: "redirect",
    to: `${target.to}/${segments.slice(1).join("/")}`,
    status: 301,
  };
}

/**
 * One lookup per segment against the slug registry.
 *
 * No ordered fallback and no mode-specific branching: the `kind` column already
 * says what a slug is, which is exactly why /leeds/big-category is unambiguous
 * and why both site modes share this function.
 */
/**
 * Pagination lives in the PATH, not a query string.
 *
 * Reading searchParams forces a route dynamic in Next 16, which would mean the
 * city pillar pages — the pages the whole business rests on — are re-rendered
 * on every request and never enter the ISR cache. A path segment keeps them
 * cacheable, and "page" is a reserved slug so nothing can collide with it.
 *
 * Exactly one spelling of a page number is a page. `Number()` would also take
 * "1e0", "0x2", "02" and " 2", and each of those is another URL serving the
 * same results — self-inflicted duplicate content on the paginated pages least
 * able to carry it. Returns null for anything else so the route 404s.
 */
const PAGE_NUMBER = /^[1-9]\d*$/;

/**
 * The largest page number that is a URL at all.
 *
 * `PAGE_NUMBER` alone is unbounded, and the pillar route queries BEFORE it can
 * know whether the page exists: `listListings`/`countListings` run with
 * `OFFSET (page - 1) * perPage`, and only the returned total tells the route to
 * 404. So `/leeds/page/1000000` makes Postgres walk twenty million rows of
 * index and throw them away — a deep-offset scan anyone can trigger by typing a
 * URL, repeatedly, at whatever rate they like.
 *
 * Absurd values are worse than slow. Past 2^53 `Number()` rounds, so the OFFSET
 * is not even the number that was asked for, and past 2^63 it overflows the
 * bigint Postgres binds it to and the query errors — a 500 where a 404 belongs.
 *
 * 10,000 pages is `10_000 * perPage` listings in one city or category, which no
 * directory this codebase builds will ever have; the real page-past-the-end
 * 404 handles everything below it. Bounded on LENGTH first so the check never
 * depends on a `Number()` that has already lost precision.
 */
export const MAX_PAGE_NUMBER = 10_000;
const MAX_PAGE_DIGITS = String(MAX_PAGE_NUMBER).length;

interface Pagination {
  rest: string[];
  page: number;
  /** Whether the path actually carried a /page/N suffix. */
  explicit: boolean;
}

export function splitPagination(segments: string[]): Pagination | null {
  if (segments.length < 2 || segments[segments.length - 2] !== "page") {
    return { rest: segments, page: 1, explicit: false };
  }
  const raw = segments[segments.length - 1] ?? "";
  if (!PAGE_NUMBER.test(raw)) return null;
  // Length before value: `Number("99999999999999999999")` is already wrong by
  // the time it could be compared. PAGE_NUMBER has ruled out a leading zero, so
  // digit count and magnitude agree.
  if (raw.length > MAX_PAGE_DIGITS) return null;
  const page = Number(raw);
  if (page > MAX_PAGE_NUMBER) return null;
  return { rest: segments.slice(0, -2), page, explicit: true };
}

/**
 * The two canonicalisation rules, for ANY catch-all route.
 *
 * Both are duplicate-content rules and neither is specific to the city
 * catch-all, so they live here rather than being reimplemented per route:
 * /categories/Some-Slug and /categories/some-slug are one page, and
 * /categories/some-slug/page/1 is the same page as /categories/some-slug.
 * A route that applies one of them and not the other is competing with itself
 * on exactly the URLs least able to carry it.
 *
 * `basePath` is the static prefix the segments hang off — "" for the city
 * catch-all at the root, "/categories" for the national category route — and
 * is prepended to the redirect target so the rule is expressible from either.
 */
export type PathNormalisation =
  | { kind: "redirect"; to: string; status: 301 }
  | { kind: "ok"; segments: string[]; lowered: string[]; page: number }
  | { kind: "not-found" };

export function normalisePathSegments(
  basePath: string,
  rawSegments: string[],
): PathNormalisation {
  // Case is not part of a URL's identity here. One canonical lowercase form,
  // and everything else 301s to it before a single query runs.
  const lowered = rawSegments.map((s) => s.toLowerCase());
  if (lowered.some((s, i) => s !== rawSegments[i])) {
    return { kind: "redirect", to: `${basePath}/${lowered.join("/")}`, status: 301 };
  }

  const pagination = splitPagination(lowered);
  if (pagination === null) return { kind: "not-found" };

  // A bare /page/N — nothing left once the suffix is stripped — is not a
  // paginated anything. Checked BEFORE the /page/1 rule so it 404s rather
  // than redirecting to the route's own base path.
  if (pagination.rest.length === 0) return { kind: "not-found" };

  // /x/page/1 is the same page as /x. Canonicalised before the lookup so the
  // rule holds for every route shape that uses this.
  if (pagination.explicit && pagination.page === 1) {
    return { kind: "redirect", to: `${basePath}/${pagination.rest.join("/")}`, status: 301 };
  }

  return { kind: "ok", segments: pagination.rest, lowered, page: pagination.page };
}

/**
 * The one segment that may follow a listing slug.
 *
 * It is matched here rather than routed as its own file because the listing
 * URL itself is resolved out of the slug registry — /[city]/[listing] is a
 * catch-all, so /[city]/[listing]/reviews cannot be a static route without
 * duplicating the whole lookup. Keeping it in the resolver is also what makes
 * it inherit the page bound, the lowercase 301 and the /page/1 rule for free
 * rather than reimplementing three canonicalisation rules on a fourth page.
 *
 * It is a literal, not a reserved slug: it only ever appears in third
 * position, where nothing else can be, so a business called Reviews still gets
 * /[city]/reviews. The flag check does NOT live here — the resolver has no
 * business knowing about features, and app/[...segments] calls guardFeature so
 * the route 404s with reviews off.
 */
export const REVIEWS_SEGMENT = "reviews";

export async function resolveRoute(
  tx: TestDb,
  rawSegments: string[],
  mode: SiteMode,
): Promise<RouteResolution> {
  // Lowercase form and /page/1 both 301 before a single query runs. Shared
  // with app/categories/[...category] — see normalisePathSegments.
  const normalised = normalisePathSegments("", rawSegments);
  if (normalised.kind !== "ok") {
    return normalised.kind === "redirect"
      ? { kind: "redirect", to: normalised.to, status: normalised.status }
      : { kind: "not-found" };
  }
  const { segments, lowered, page } = normalised;
  // Whether a /page/N suffix was carried: `segments` has it stripped.
  const explicit = lowered.length !== segments.length;

  const path = `/${lowered.join("/")}`;
  const first = segments[0];
  if (first === undefined) return { kind: "not-found" };

  const root = await resolveSlug(tx, ROOT_SCOPE, first);

  // A reserved slug reaching this resolver means the static route did not
  // match, so there is nothing here. Never fall through to a lookup.
  if (root?.kind === "static") return { kind: "not-found" };

  const expectedRootKind = mode === "niche-national" ? "city" : "vertical";
  if (!root || root.kind !== expectedRootKind || root.entityId === null) {
    return (
      (await redirectFor(tx, path)) ??
      (await rootPrefixRedirect(tx, lowered)) ?? { kind: "not-found" }
    );
  }
  const parentId = root.entityId;

  if (segments.length === 1) {
    return {
      kind: "pillar",
      page,
      scope:
        mode === "niche-national"
          ? { type: "city", cityId: parentId }
          : { type: "vertical", verticalId: parentId },
    };
  }

  // Exactly one three-segment shape exists, and only under a listing. Anything
  // else three deep is still a 404 — /[city]/[category]/[listing] never was a
  // URL and must not become one by way of this branch.
  const reviews = segments.length === 3 && segments[2] === REVIEWS_SEGMENT;

  const second = segments[1];
  if (second === undefined || segments.length > (reviews ? 3 : 2)) {
    return (await redirectFor(tx, path)) ?? { kind: "not-found" };
  }

  const child = await resolveSlug(tx, parentId, second);
  if (!child || child.entityId === null) {
    return (await redirectFor(tx, path)) ?? { kind: "not-found" };
  }

  switch (child.kind) {
    case "category":
      // A category has no reviews of its own; only a listing does. A path that
      // once existed still gets its redirect, though — an exact `redirects`
      // row beats resolution everywhere else in this function, and the word in
      // third position is no reason to make this the one place it does not.
      if (reviews) return (await redirectFor(tx, path)) ?? { kind: "not-found" };
      return {
        kind: "pillar",
        page,
        scope: { type: "city-category", cityId: parentId, categoryId: child.entityId },
      };
    case "area":
      if (reviews) return (await redirectFor(tx, path)) ?? { kind: "not-found" };
      return {
        kind: "pillar",
        page,
        scope: { type: "vertical-area", verticalId: parentId, areaId: child.entityId },
      };
    case "listing":
      // The reviews sub-page IS a list, so it paginates; the detail page is
      // one page, and /listing/page/2 would serve it again under a second URL.
      if (reviews) return { kind: "listing-reviews", listingId: child.entityId, parentId, page };
      if (explicit) return { kind: "not-found" };
      return { kind: "listing", listingId: child.entityId, parentId };
    default:
      return { kind: "not-found" };
  }
}
