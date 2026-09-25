import { jobsBoardPath } from "@/lib/jobs/routes";

/**
 * The page a saved search came from, rebuilt from its stored params — the
 * digest's "and N more" link and the account list's "view" link.
 *
 * Listings: every string value becomes a query parameter, and a nested
 * object (the custom-field facets) is flattened one level, which is how
 * app/search/page.tsx reads them. Nothing here names a filter, so one added
 * to the search later round-trips without a change. Jobs: the board's own
 * path grammar (lib/jobs/routes.ts).
 */
export function savedSearchPath(kind: "listings" | "jobs", params: Record<string, unknown>): string {
  if (kind === "jobs") {
    const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
    return jobsBoardPath({ citySlug: str(params.citySlug), categorySlug: str(params.categorySlug) });
  }
  const qs = new URLSearchParams();
  const add = (key: string, value: unknown) => {
    if (typeof value === "string" && value !== "") qs.set(key, value);
    else if (typeof value === "number" || typeof value === "boolean") qs.set(key, String(value));
  };
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      for (const [k, v] of Object.entries(value)) add(k, v);
    } else {
      add(key, value);
    }
  }
  const query = qs.toString();
  return query === "" ? "/search" : `/search?${query}`;
}
