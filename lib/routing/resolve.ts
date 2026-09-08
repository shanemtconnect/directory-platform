import { eq } from "drizzle-orm";
import { redirects } from "@/lib/db/schema";
import type { SiteMode } from "@/config/types";
import type { TestDb } from "@/test/db";
import { resolveSlug, ROOT_SCOPE } from "./slugs";
import type { PillarScope } from "./scope";

export type RouteResolution =
  | { kind: "pillar"; scope: PillarScope; page: number }
  | { kind: "listing"; listingId: string; parentId: string }
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
  return { rest: segments.slice(0, -2), page: Number(raw), explicit: true };
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

  const second = segments[1];
  if (segments.length > 2 || second === undefined) {
    return (await redirectFor(tx, path)) ?? { kind: "not-found" };
  }

  const child = await resolveSlug(tx, parentId, second);
  if (!child || child.entityId === null) {
    return (await redirectFor(tx, path)) ?? { kind: "not-found" };
  }

  switch (child.kind) {
    case "category":
      return {
        kind: "pillar",
        page,
        scope: { type: "city-category", cityId: parentId, categoryId: child.entityId },
      };
    case "area":
      return {
        kind: "pillar",
        page,
        scope: { type: "vertical-area", verticalId: parentId, areaId: child.entityId },
      };
    case "listing":
      // A listing is one page. /listing/page/2 would serve the same detail page
      // again under a second URL, so it is not a URL at all.
      if (explicit) return { kind: "not-found" };
      return { kind: "listing", listingId: child.entityId, parentId };
    default:
      return { kind: "not-found" };
  }
}
