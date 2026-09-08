import { and, eq, or, ilike, sql, type SQL } from "drizzle-orm";
import { listings, cities, categories } from "@/lib/db/schema";
import { listingRankOrder } from "@/lib/db/sort";
import { siteConfig } from "@/config/site.config";
import type { CustomField } from "@/config/types";
import { isAdmin, type Viewer } from "@/lib/db/viewer";
import type { TestDb } from "@/test/db";

export const SEARCH_PER_PAGE = 24;

export interface SearchParams {
  q?: string;
  city?: string;
  category?: string;
  /** Values for customFields marked searchable, keyed by field key. */
  fields?: Record<string, string>;
  page?: number;
}

export interface SearchResult {
  rows: (typeof listings.$inferSelect & { cityName: string; citySlug: string })[];
  total: number;
  page: number;
  totalPages: number;
}

/**
 * Faceted search across the whole site.
 *
 * Free-text matches name and description only — not address. Matching on
 * address makes every query in a big city return everything, which reads as
 * broken.
 */
function buildWhere(viewer: Viewer, params: SearchParams): SQL {
  const clauses: SQL[] = [];

  if (!isAdmin(viewer)) clauses.push(eq(listings.status, "published"));

  const q = params.q?.trim();
  if (q) {
    const term = `%${q.replace(/[%_]/g, (m) => `\\${m}`)}%`;
    clauses.push(
      or(
        ilike(listings.name, term),
        ilike(listings.shortDescription, term),
        ilike(listings.description, term),
      )!,
    );
  }

  if (params.city) clauses.push(eq(cities.slug, params.city));
  if (params.category) clauses.push(eq(categories.slug, params.category));

  // Custom fields live in jsonb. Only keys declared searchable in site.config
  // are honoured — an arbitrary key from a query string must never reach SQL.
  // `as const satisfies` narrows the literal union, so widen it to read here.
  const customFields: readonly CustomField[] = siteConfig.customFields;
  const searchable = new Map(
    customFields.filter((f) => f.searchable === true).map((f) => [f.key, f]),
  );
  for (const [key, raw] of Object.entries(params.fields ?? {})) {
    const field = searchable.get(key);
    if (!field || raw === "") continue;

    if (field.type === "boolean") {
      if (raw === "true") clauses.push(sql`${listings.customFields} ->> ${key} = 'true'`);
    } else if (field.type === "number" || field.type === "currency") {
      const n = Number(raw);
      if (Number.isFinite(n)) {
        clauses.push(sql`(${listings.customFields} ->> ${key})::numeric >= ${n}`);
      }
    } else {
      clauses.push(sql`${listings.customFields} ->> ${key} = ${raw}`);
    }
  }

  return clauses.length > 0 ? and(...clauses)! : sql`true`;
}

export async function search(
  tx: TestDb,
  viewer: Viewer,
  params: SearchParams,
): Promise<SearchResult> {
  const page = Math.max(1, Math.trunc(params.page ?? 1));
  const where = buildWhere(viewer, params);

  const [rows, countRows] = await Promise.all([
    tx
      .select({
        listing: listings,
        cityName: cities.name,
        citySlug: cities.slug,
      })
      .from(listings)
      .innerJoin(cities, eq(cities.id, listings.cityId))
      .leftJoin(categories, eq(categories.id, listings.primaryCategoryId))
      .where(where)
      .orderBy(...listingRankOrder(siteConfig.timezone))
      .limit(SEARCH_PER_PAGE)
      .offset((page - 1) * SEARCH_PER_PAGE),
    tx
      .select({ n: sql<number>`count(*)::int` })
      .from(listings)
      .innerJoin(cities, eq(cities.id, listings.cityId))
      .leftJoin(categories, eq(categories.id, listings.primaryCategoryId))
      .where(where),
  ]);

  const total = countRows[0]?.n ?? 0;
  return {
    rows: rows.map((r) => ({ ...r.listing, cityName: r.cityName, citySlug: r.citySlug })),
    total,
    page,
    totalPages: Math.max(1, Math.ceil(total / SEARCH_PER_PAGE)),
  };
}
