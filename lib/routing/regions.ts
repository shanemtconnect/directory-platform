import { normalisePathSegments } from "./resolve";

/**
 * The region pages: /areas and /areas/<region>/page/N.
 *
 * Constraint 11 of the master plan says a region never appears in a LISTING
 * URL — a listing is /[city]/[listing] whatever county it sits in. A region
 * still gets a page of its own, one level down from the reserved /areas
 * segment, and this module is the only place that spells those paths.
 */
export const REGION_BASE = "/areas";

export const regionPath = (slug: string): string => `${REGION_BASE}/${slug}`;

export const regionPagePath = (slug: string, page: number): string =>
  page === 1 ? regionPath(slug) : `${regionPath(slug)}/page/${page}`;

export type ParsedRegionPath =
  | { kind: "page"; slug: string; page: number }
  | { kind: "redirect"; to: string }
  | { kind: "not-found" };

/**
 * The same canonicalisation rules as the city catch-all and the national
 * category route, from the same helper: mixed case 301s to lowercase,
 * /page/1 301s to the bare page, and only one spelling of a page number is a
 * page. A region page is exactly one segment deep; anything else is a 404.
 */
export function parseRegionSegments(segments: string[]): ParsedRegionPath {
  const normalised = normalisePathSegments(REGION_BASE, segments);
  if (normalised.kind === "redirect") return { kind: "redirect", to: normalised.to };
  if (normalised.kind === "not-found") return { kind: "not-found" };
  if (normalised.segments.length !== 1) return { kind: "not-found" };
  const slug = normalised.segments[0];
  if (slug === undefined || slug === "") return { kind: "not-found" };
  return { kind: "page", slug, page: normalised.page };
}
