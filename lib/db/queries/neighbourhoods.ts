import { and, asc, eq, inArray, isNotNull, ne, or, sql } from "drizzle-orm";
import { areas, categories, cities, listings, slugs } from "@/lib/db/schema";
import { siteConfig } from "@/config/site.config";
import { isAdmin, PUBLIC_VIEWER, type Viewer } from "@/lib/db/viewer";
import { countListings, publishedListings } from "@/lib/db/queries/listings";
import { paginatedPaths } from "@/lib/db/queries/paths";
import { writeAudit } from "@/lib/db/queries/audit";
import { enqueueJob } from "@/lib/db/queries/jobs";
import { now } from "@/lib/clock";
import {
  decideNeighbourhoodIndexability,
  nearestNeighbourhood,
  type CsvProblem,
  type NeighbourhoodCsvRow,
} from "@/lib/geo/neighbourhoods";
import type { TestDb } from "@/lib/db/types";

/**
 * Neighbourhoods under towns (Task 52) — everything that touches the database.
 *
 * A neighbourhood is an `areas` row with `city_id` set, and a `slugs` row of
 * kind `area` in its town's scope. That single registry namespace is what
 * keeps a neighbourhood from shadowing a category or a listing in the same
 * town: the importer refuses the collision, and the resolver never has to
 * choose. local-multi-vertical `areas` rows have `city_id` null and nothing
 * here selects them.
 */

/** The job_queue kind the admin "assign now" button enqueues, and the cron's lock name. */
export const NEIGHBOURHOODS_ASSIGN_KIND = "neighbourhoods.assign";

function assertAdmin(viewer: Viewer): void {
  if (!isAdmin(viewer)) throw new Error("FORBIDDEN");
}

const PUBLISHED = publishedListings(PUBLIC_VIEWER);

/**
 * The live published count per neighbourhood, over `countedListings` joined
 * in. A join rather than a correlated sub-select because Drizzle drops table
 * qualifiers on a single-table select, and `"area_id" = "id"` inside a
 * sub-select then compares a listing to itself.
 */
const publishedCount = sql<number>`count(${listings.id})::int`;
const countedListings = and(eq(listings.areaId, areas.id), eq(listings.cityId, areas.cityId), PUBLISHED);

/* ---------------------------------------------------------------- public */

export interface NeighbourhoodLink {
  id: string;
  name: string;
  slug: string;
  listingCount: number;
}

/**
 * The town page's "Neighbourhoods" block: published neighbourhoods with at
 * least one published listing, live counts, by name. A neighbourhood with
 * none is a link to an empty page, and the block exists to spread link
 * equity to pages that have something on them.
 *
 * Viewer-blind like the sitemap: this renders into the ISR-cached town page
 * every visitor then reads back.
 */
export async function cityNeighbourhoods(
  tx: TestDb,
  _viewer: Viewer,
  cityId: string,
): Promise<NeighbourhoodLink[]> {
  const rows = await tx
    .select({ id: areas.id, name: areas.name, slug: areas.slug, listingCount: publishedCount })
    .from(areas)
    .leftJoin(listings, countedListings)
    .where(and(eq(areas.cityId, cityId), eq(areas.isPublished, true)))
    .groupBy(areas.id)
    .orderBy(asc(areas.name));
  return rows.filter((r) => r.listingCount > 0);
}

/**
 * Neighbourhood pages for the sitemap: published, in a published town, and
 * at or above `geo.neighbourhoods.minListings` — the same rule the page's
 * `noindex` is decided on, from the same live count.
 */
export async function sitemapNeighbourhoods(
  tx: TestDb,
  _viewer: Viewer,
): Promise<{ path: string; lastModified: Date }[]> {
  const rows = await tx
    .select({
      citySlug: cities.slug,
      slug: areas.slug,
      updatedAt: areas.updatedAt,
      listingCount: publishedCount,
    })
    .from(areas)
    .leftJoin(listings, countedListings)
    .innerJoin(cities, eq(cities.id, areas.cityId))
    .where(and(eq(areas.isPublished, true), eq(cities.isPublished, true)))
    .groupBy(areas.id, cities.slug)
    .orderBy(asc(cities.slug), asc(areas.slug));
  return rows
    .filter((r) => decideNeighbourhoodIndexability(r.listingCount).isIndexable)
    .map((r) => ({ path: `/${r.citySlug}/${r.slug}`, lastModified: r.updatedAt }));
}

/* ----------------------------------------------------------------- admin */

export interface AdminNeighbourhood {
  id: string;
  name: string;
  slug: string;
  lat: number | null;
  lng: number | null;
  radiusKm: number | null;
  isPublished: boolean;
  /** Live published count, not the cached column. */
  listingCount: number;
}

export interface AdminNeighbourhoodTown {
  cityId: string;
  cityName: string;
  citySlug: string;
  neighbourhoods: AdminNeighbourhood[];
}

/** Every neighbourhood, grouped by town, unpublished ones included. */
export async function adminNeighbourhoods(tx: TestDb, viewer: Viewer): Promise<AdminNeighbourhoodTown[]> {
  assertAdmin(viewer);
  const rows = await tx
    .select({
      cityId: cities.id,
      cityName: cities.name,
      citySlug: cities.slug,
      id: areas.id,
      name: areas.name,
      slug: areas.slug,
      lat: areas.lat,
      lng: areas.lng,
      radiusKm: areas.radiusKm,
      isPublished: areas.isPublished,
      listingCount: publishedCount,
    })
    .from(areas)
    .leftJoin(listings, countedListings)
    .innerJoin(cities, eq(cities.id, areas.cityId))
    .groupBy(areas.id, cities.id)
    .orderBy(asc(cities.name), asc(areas.name));

  const towns = new Map<string, AdminNeighbourhoodTown>();
  for (const { cityId, cityName, citySlug, ...n } of rows) {
    let town = towns.get(cityId);
    if (!town) {
      town = { cityId, cityName, citySlug, neighbourhoods: [] };
      towns.set(cityId, town);
    }
    town.neighbourhoods.push(n);
  }
  return [...towns.values()];
}

export interface ImportOutcome {
  created: number;
  updated: number;
  skipped: CsvProblem[];
  /** Town and neighbourhood pages (paginated ones included) of every town the upload touched. */
  revalidate: string[];
}

/**
 * The ISR pages of one town that neighbourhood changes leave stale: the town
 * pillar and its paginated pages (the "Neighbourhoods" block is on every one
 * of them), and each neighbourhood's page and paginated pages. Counts are
 * live and published-only, plus one, the same over-inclusive-by-one rule as
 * `resolveListingPaths`: a page that is about to appear or disappear is busted
 * too. Call it before AND after a change that moves listings, and bust both.
 */
export async function townNeighbourhoodPaths(tx: TestDb, cityId: string): Promise<string[]> {
  const [city] = await tx.select({ slug: cities.slug }).from(cities).where(eq(cities.id, cityId)).limit(1);
  if (!city) return [];
  const townCount = await countListings(tx as never, PUBLIC_VIEWER, { type: "city", cityId });
  const hoods = await tx
    .select({ slug: areas.slug, listingCount: publishedCount })
    .from(areas)
    .leftJoin(listings, countedListings)
    .where(eq(areas.cityId, cityId))
    .groupBy(areas.id);
  const town = `/${city.slug}`;
  return [
    town,
    ...paginatedPaths(town, townCount + 1),
    ...hoods.flatMap((h) => [`${town}/${h.slug}`, ...paginatedPaths(`${town}/${h.slug}`, h.listingCount + 1)]),
  ];
}

/**
 * Why a slug cannot be a neighbourhood in this town, or null when it can.
 * `existingAreaId` is set when the slug is already THIS town's neighbourhood,
 * which a re-import updates rather than refuses.
 */
async function slugConflict(
  tx: TestDb,
  cityId: string,
  slug: string,
): Promise<{ problem: string | null; existingAreaId: string | null }> {
  const [held] = await tx
    .select({ kind: slugs.kind, entityId: slugs.entityId })
    .from(slugs)
    .where(and(eq(slugs.parentScope, cityId), eq(slugs.slug, slug)))
    .limit(1);
  if (held) {
    if (held.kind === "area" && held.entityId !== null) {
      return { problem: null, existingAreaId: held.entityId };
    }
    const what = held.kind === "category" ? "a category" : held.kind === "listing" ? "a listing" : `a ${held.kind}`;
    return { problem: `"${slug}" is already ${what} in this town.`, existingAreaId: null };
  }

  // A category not routed in this town YET: its first listing here would find
  // the slug taken and land the category at /<town>/<slug>-2.
  const [category] = await tx
    .select({ id: categories.id })
    .from(categories)
    .where(eq(categories.slug, slug))
    .limit(1);
  if (category) return { problem: `"${slug}" is a category's slug, and a category keeps it in every town.`, existingAreaId: null };

  // Another town's neighbourhood with the same slug is no clash: `areas` is
  // unique on (town, slug), and every town may have its own "city-centre".
  return { problem: null, existingAreaId: null };
}

/**
 * Writes parsed CSV rows. Per row: the town must exist, and the slug must be
 * free in it — or already be this town's neighbourhood, which is then
 * updated (so a corrected file can be re-uploaded). A refused row is
 * reported by line and skipped; the rest still import. One audit row for the
 * upload, on the caller's transaction.
 */
export async function importNeighbourhoods(
  tx: TestDb,
  viewer: Viewer,
  rows: readonly NeighbourhoodCsvRow[],
  opts: { ip?: string | null },
): Promise<ImportOutcome> {
  assertAdmin(viewer);
  const out: ImportOutcome = { created: 0, updated: 0, skipped: [], revalidate: [] };
  const cityIds = new Map<string, string | null>();
  /** `cityId:slug` this upload has already WRITTEN — a refused row is not recorded. */
  const seen = new Set<string>();
  const touched = new Set<string>();

  for (const row of rows) {
    if (!cityIds.has(row.citySlug)) {
      const [city] = await tx.select({ id: cities.id }).from(cities).where(eq(cities.slug, row.citySlug)).limit(1);
      cityIds.set(row.citySlug, city?.id ?? null);
    }
    const cityId = cityIds.get(row.citySlug) ?? null;
    if (cityId === null) {
      out.skipped.push({ line: row.line, message: `There is no town with the slug "${row.citySlug}".` });
      continue;
    }

    // The same town and slug twice in one file: the first row that was written
    // stands. Without this the second would silently "update" it. A first copy
    // that was refused is not "written", so a second copy gets the real reason.
    const key = `${cityId}:${row.slug}`;
    if (seen.has(key)) {
      out.skipped.push({ line: row.line, message: `"${row.slug}" appears twice for this town in the file; only the first row was used.` });
      continue;
    }

    const { problem, existingAreaId } = await slugConflict(tx, cityId, row.slug);
    if (problem !== null) {
      out.skipped.push({ line: row.line, message: problem });
      continue;
    }

    const values = { name: row.name, lat: row.lat, lng: row.lng, radiusKm: row.radiusKm };
    if (existingAreaId !== null) {
      await tx.update(areas).set({ ...values, updatedAt: now() }).where(eq(areas.id, existingAreaId));
      out.updated++;
      seen.add(key);
      touched.add(cityId);
      continue;
    }

    const [area] = await tx
      .insert(areas)
      .values({ ...values, slug: row.slug, cityId, isPublished: true })
      .returning({ id: areas.id });
    // Exactly this slug or nothing: allocateSlug's -2 ladder would publish
    // the neighbourhood at a URL the admin never asked for.
    const claimed = await tx
      .insert(slugs)
      .values({ parentScope: cityId, slug: row.slug, kind: "area", entityId: area!.id })
      .onConflictDoNothing()
      .returning({ id: slugs.id });
    if (claimed.length === 0) {
      await tx.delete(areas).where(eq(areas.id, area!.id));
      out.skipped.push({ line: row.line, message: `"${row.slug}" was taken in this town while importing.` });
      continue;
    }
    out.created++;
    seen.add(key);
    touched.add(cityId);
  }
  for (const cityId of touched) out.revalidate.push(...(await townNeighbourhoodPaths(tx, cityId)));

  await writeAudit(tx, viewer, {
    action: "neighbourhoods.imported",
    entityType: "area",
    meta: { created: out.created, updated: out.updated, skipped: out.skipped.length },
    ip: opts.ip ?? null,
  });
  return out;
}

/**
 * Publishes or unpublishes one neighbourhood. `ok: false` for anything that
 * is not a neighbourhood — an unknown id, or a local-multi-vertical area,
 * which this console does not own.
 */
export async function setNeighbourhoodPublished(
  tx: TestDb,
  viewer: Viewer,
  areaId: string,
  published: boolean,
  opts: { ip?: string | null },
): Promise<{ ok: true; citySlug: string; slug: string } | { ok: false }> {
  assertAdmin(viewer);
  const [row] = await tx
    .select({ slug: areas.slug, citySlug: cities.slug })
    .from(areas)
    .innerJoin(cities, eq(cities.id, areas.cityId))
    .where(eq(areas.id, areaId))
    .limit(1);
  if (!row) return { ok: false };

  await tx.update(areas).set({ isPublished: published, updatedAt: now() }).where(eq(areas.id, areaId));
  await writeAudit(tx, viewer, {
    action: published ? "neighbourhood.published" : "neighbourhood.unpublished",
    entityType: "area",
    entityId: areaId,
    ip: opts.ip ?? null,
  });
  return { ok: true, citySlug: row.citySlug, slug: row.slug };
}

/** The admin "assign now" button: one queued run for the worker, audited. */
export async function enqueueNeighbourhoodAssign(
  tx: TestDb,
  viewer: Viewer,
  opts: { ip?: string | null },
): Promise<string> {
  assertAdmin(viewer);
  const id = await enqueueJob(tx, viewer, { kind: NEIGHBOURHOODS_ASSIGN_KIND, payload: {}, runAfter: now() });
  await writeAudit(tx, viewer, {
    action: "neighbourhoods.assign_queued",
    entityType: "job_queue",
    entityId: id,
    ip: opts.ip ?? null,
  });
  return id;
}

/* ---------------------------------------------------------------- assign */

export interface AssignOutcome {
  /** Towns that have neighbourhoods and were processed. */
  cities: number;
  /** Listings whose `area_id` changed. */
  changed: number;
  /** The town and neighbourhood pages (paginated too) of every town where something moved. */
  revalidate: string[];
  /** Slugs of towns whose run failed and was rolled back; the others still committed. */
  failed: string[];
}

/** Ids per UPDATE: well under Postgres's 65,535 bind parameters, and a sane statement size. */
export const ASSIGN_CHUNK_SIZE = 5000;

/**
 * Sets every listing's `area_id` in each town with neighbourhoods to the
 * nearest centroid within its radius (lib/geo/neighbourhoods.ts), clears it
 * where none reaches or the listing has no coordinates, then recounts each
 * neighbourhood's cached `listing_count` / `is_indexable`.
 *
 * Every listing in the town is placed, published or not, so one that is
 * approved tomorrow is already in the right neighbourhood; the counts are
 * published-only, because that is what the page shows. Idempotent: a second
 * run changes nothing and asks for nothing to be revalidated.
 *
 * Each town runs in its own savepoint: one town that fails is rolled back and
 * named in `failed`, and every other town's moves still commit. Moves are
 * written `ASSIGN_CHUNK_SIZE` ids at a time.
 */
export async function assignNeighbourhoods(
  tx: TestDb,
  viewer: Viewer,
  opts: { cityId?: string; chunkSize?: number } = {},
): Promise<AssignOutcome> {
  assertAdmin(viewer);
  const chunkSize = Math.max(1, Math.min(opts.chunkSize ?? ASSIGN_CHUNK_SIZE, ASSIGN_CHUNK_SIZE));
  const towns = await tx
    .selectDistinct({ cityId: cities.id, citySlug: cities.slug })
    .from(areas)
    .innerJoin(cities, eq(cities.id, areas.cityId))
    .where(opts.cityId === undefined ? isNotNull(areas.cityId) : eq(areas.cityId, opts.cityId));

  const out: AssignOutcome = { cities: towns.length, changed: 0, revalidate: [], failed: [] };

  for (const town of towns) {
    try {
      const result = await tx.transaction(async (sp) =>
        assignTown(sp as unknown as TestDb, town.cityId, chunkSize),
      );
      out.changed += result.changed;
      out.revalidate.push(...result.revalidate);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`[neighbourhoods] assignment for ${town.citySlug} failed and was rolled back: ${message.slice(0, 200)}`);
      out.failed.push(town.citySlug);
    }
  }
  out.revalidate = [...new Set(out.revalidate)];
  return out;
}

/** One town, on the savepoint `assignNeighbourhoods` opened for it. */
async function assignTown(
  tx: TestDb,
  cityId: string,
  chunkSize: number,
): Promise<{ changed: number; revalidate: string[] }> {
  const minListings = siteConfig.geo.neighbourhoods.minListings;
  // Before the moves: a neighbourhood page that shrinks loses its last page,
  // and that cached page is exactly the one that has to go.
  const before = await townNeighbourhoodPaths(tx, cityId);

  const centroids = await tx
    .select({ id: areas.id, slug: areas.slug, lat: areas.lat, lng: areas.lng, radiusKm: areas.radiusKm })
    .from(areas)
    .where(eq(areas.cityId, cityId));
  const rows = await tx
    .select({ id: listings.id, lat: listings.lat, lng: listings.lng, areaId: listings.areaId })
    .from(listings)
    .where(eq(listings.cityId, cityId));

  const moves = new Map<string | null, string[]>();
  for (const l of rows) {
    const target = l.lat === null || l.lng === null
      ? null
      : nearestNeighbourhood({ lat: l.lat, lng: l.lng }, centroids);
    if (target === l.areaId) continue;
    const ids = moves.get(target) ?? [];
    ids.push(l.id);
    moves.set(target, ids);
  }

  let changed = 0;
  for (const [target, ids] of moves) {
    for (let i = 0; i < ids.length; i += chunkSize) {
      await tx.update(listings).set({ areaId: target }).where(inArray(listings.id, ids.slice(i, i + chunkSize)));
    }
    changed += ids.length;
  }

  for (const c of centroids) {
    const [{ n } = { n: 0 }] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(listings)
      .where(and(eq(listings.cityId, cityId), eq(listings.areaId, c.id), PUBLISHED));
    const decided = decideNeighbourhoodIndexability(n, minListings);
    await tx
      .update(areas)
      .set({ listingCount: decided.listingCount, isIndexable: decided.isIndexable })
      .where(and(
        eq(areas.id, c.id),
        or(ne(areas.listingCount, decided.listingCount), ne(areas.isIndexable, decided.isIndexable)),
      ));
  }

  if (changed === 0) return { changed, revalidate: [] };
  return { changed, revalidate: [...before, ...(await townNeighbourhoodPaths(tx, cityId))] };
}
