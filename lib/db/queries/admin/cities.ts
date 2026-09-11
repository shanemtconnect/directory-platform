import { asc, eq, sql } from "drizzle-orm";
import { cities } from "@/lib/db/schema";
import { recomputeCityIndexability } from "@/lib/db/queries/indexing";
import { writeAudit } from "@/lib/db/queries/audit";
import { isAdmin, type Viewer } from "@/lib/db/viewer";
import type { TestDb } from "@/test/db";

/**
 * The city queue: which pages are thin, which are waiting on copy, and the two
 * edits that change either.
 *
 * Constraint 9 is the whole point of this file. `is_indexable` is never set by
 * hand here — both writes call `recomputeCityIndexability` on the same handle,
 * so a city cannot be flagged indexable by an admin who thinks it deserves it,
 * and cannot stay flagged once the copy is deleted.
 */

const ESCAPES: Record<string, string> = {
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
};

/**
 * Turns what an admin typed into paragraphs.
 *
 * The form is a plain textarea and NO markup survives it: every `<` the column
 * ends up holding was written by this function. `intro_html` is rendered with
 * `dangerouslySetInnerHTML` (through `sanitiseRichText`) on the pillar page, so
 * an admin console that accepted raw HTML would be a stored-XSS field with a
 * login in front of it — and the login is not the hard part to get past.
 *
 * Blank lines separate paragraphs; a single newline is a wrap, not a break, so
 * it collapses to a space rather than becoming a `<br>` nobody asked for.
 * Returns null for nothing at all, which is what the gate reads as "no copy".
 */
export function introHtmlFromText(text: string): string | null {
  const paragraphs = text
    .replace(/\r\n/g, "\n")
    .split(/\n\s*\n/)
    .map((block) => block.trim().replace(/\s*\n\s*/g, " "))
    .filter((block) => block !== "");
  if (paragraphs.length === 0) return null;

  return paragraphs
    .map((block) => `<p>${block.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c)}</p>`)
    .join("\n");
}

function assertAdmin(viewer: Viewer): void {
  if (!isAdmin(viewer)) throw new Error("FORBIDDEN");
}

export interface AdminCity {
  id: string;
  name: string;
  slug: string;
  region: string | null;
  isPublished: boolean;
  isIndexable: boolean;
  /** The STORED count, which only a recompute updates. */
  listingCount: number;
  createdBy: "seed" | "admin" | "auto";
  hasIntro: boolean;
}

export async function adminCities(tx: TestDb, viewer: Viewer): Promise<AdminCity[]> {
  assertAdmin(viewer);

  return tx
    .select({
      id: cities.id,
      name: cities.name,
      slug: cities.slug,
      region: cities.region,
      isPublished: cities.isPublished,
      isIndexable: cities.isIndexable,
      listingCount: cities.listingCount,
      createdBy: cities.createdBy,
      hasIntro: sql<boolean>`(${cities.introHtml} is not null and btrim(${cities.introHtml}) <> '')`,
    })
    .from(cities)
    .orderBy(asc(cities.name), asc(cities.slug));
}

/** Published cities with no intro copy: the work the dashboard counts. */
export async function countCitiesAwaitingIntro(tx: TestDb, viewer: Viewer): Promise<number> {
  assertAdmin(viewer);
  const [row] = await tx
    .select({ total: sql<number>`count(*)::int` })
    .from(cities)
    .where(sql`${cities.isPublished} and (${cities.introHtml} is null or btrim(${cities.introHtml}) = '')`);
  return row?.total ?? 0;
}

export type CityEditResult =
  | { outcome: "saved"; listingCount: number; isIndexable: boolean }
  | { outcome: "unknown-city" };

export interface CityEditOptions {
  ip: string | null;
}

/** True when the city exists. Cheap, and it keeps both writes honest. */
async function cityExists(tx: TestDb, cityId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: cities.id })
    .from(cities)
    .where(eq(cities.id, cityId))
    .limit(1);
  return row !== undefined;
}

export async function saveCityIntro(
  tx: TestDb,
  viewer: Viewer,
  cityId: string,
  text: string,
  opts: CityEditOptions,
): Promise<CityEditResult> {
  assertAdmin(viewer);
  if (!(await cityExists(tx, cityId))) return { outcome: "unknown-city" };

  const introHtml = introHtmlFromText(text);
  await tx.update(cities).set({ introHtml }).where(eq(cities.id, cityId));

  // After the write, so it judges the copy that is now stored rather than the
  // copy that was there a moment ago.
  const gate = await recomputeCityIndexability(tx, viewer, cityId);

  await writeAudit(tx, viewer, {
    action: "city.intro_saved",
    entityType: "city",
    entityId: cityId,
    // The copy itself is in the column and the column is the record; the audit
    // row carries the decision it produced.
    meta: { hasIntro: introHtml !== null, isIndexable: gate?.isIndexable ?? false },
    ip: opts.ip,
  });

  return {
    outcome: "saved",
    listingCount: gate?.listingCount ?? 0,
    isIndexable: gate?.isIndexable ?? false,
  };
}

export async function setCityPublished(
  tx: TestDb,
  viewer: Viewer,
  cityId: string,
  isPublished: boolean,
  opts: CityEditOptions,
): Promise<CityEditResult> {
  assertAdmin(viewer);
  if (!(await cityExists(tx, cityId))) return { outcome: "unknown-city" };

  await tx.update(cities).set({ isPublished }).where(eq(cities.id, cityId));
  const gate = await recomputeCityIndexability(tx, viewer, cityId);

  await writeAudit(tx, viewer, {
    action: isPublished ? "city.published" : "city.unpublished",
    entityType: "city",
    entityId: cityId,
    meta: { isPublished, isIndexable: gate?.isIndexable ?? false },
    ip: opts.ip,
  });

  return {
    outcome: "saved",
    listingCount: gate?.listingCount ?? 0,
    isIndexable: gate?.isIndexable ?? false,
  };
}
