import { and, eq, or, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { randomUUID } from "node:crypto";
import { listings, suppressions, cities, categories } from "@/lib/db/schema";
import { allocateSlug } from "@/lib/routing/slugs";
import { normalisePostcode } from "@/lib/geo/countries";
import { recomputeCityIndexability } from "@/lib/db/queries/indexing";
import { now } from "@/lib/clock";
import type { Viewer } from "@/lib/db/viewer";
import type { Db } from "@/lib/db/client";

/**
 * Two modes, and they are not interchangeable.
 *
 *  scraped  — public-register data used to seed a site. Descriptions are
 *             REJECTED: a description in a scraped feed is someone else's
 *             copyright, and a directory built on copied text ranks badly.
 *  authored — our own written content, supplied as CSV. Descriptions kept.
 *
 * Both modes check suppressions and duplicates, record provenance, and set
 * claim_status 'unclaimed' with no rating and nothing verified.
 */
export type ImportMode = "scraped" | "authored";

export interface ImportRow {
  name: string;
  city: string;
  /**
   * County/state, for disambiguation only — never a URL segment. Optional
   * because most feeds do not carry one, but without it a feed containing
   * Richmond or Newport cannot be imported at all.
   */
  region?: string;
  category: string;
  addressLine1?: string;
  postcode?: string;
  phone?: string;
  email?: string;
  website?: string;
  sourceUrl?: string;
  description?: string;
}

export interface ImportReport {
  inserted: number;
  duplicates: number;
  suppressed: number;
  rejected: number;
  notes: string[];
}

export const normaliseName = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, " ");
export const normalisePhone = (s: string): string => s.replace(/[^0-9]/g, "");

/** Digits only, in SQL, so "(0113) 496-0000" matches "01134960000". */
const phoneDigits = (column: AnyPgColumn): SQL =>
  sql`regexp_replace(coalesce(${column}, ''), '[^0-9]', '', 'g')`;

/**
 * The one place a feed's town name becomes a city id.
 *
 * Matching on name alone is not merely imprecise, it is wrong: Richmond is in
 * both North Yorkshire and London, Newport is in Wales and on the Isle of
 * Wight, and picking the first row silently files half a feed under the wrong
 * town. Ambiguity is an error the operator has to resolve by adding a region
 * column, never a coin toss.
 */
export async function resolveImportCity(tx: Db, row: ImportRow): Promise<string> {
  const name = row.city.trim().toLowerCase();
  const conditions = [sql`lower(${cities.name}) = ${name}`];
  if (row.region !== undefined && row.region.trim() !== "") {
    conditions.push(sql`lower(coalesce(${cities.region}, '')) = ${row.region.trim().toLowerCase()}`);
  }

  const matches = await tx
    .select({ id: cities.id, region: cities.region })
    .from(cities)
    .where(and(...conditions))
    .limit(2);

  const [first, second] = matches;
  if (!first) {
    const where = row.region ? ` in "${row.region}"` : "";
    throw new Error(
      `Unknown city "${row.city}"${where} for "${row.name}". ` +
        `Add the city before importing, or correct the file.`,
    );
  }
  if (second) {
    const regions = await tx
      .select({ region: cities.region })
      .from(cities)
      .where(sql`lower(${cities.name}) = ${name}`);
    const named = regions.map((r) => r.region ?? "(no region)").join(", ");
    throw new Error(
      `Ambiguous city "${row.city}" for "${row.name}" — matches ${named}. ` +
        `Add a region column to the import file.`,
    );
  }
  return first.id;
}

/**
 * A suppressed business must stay suppressed however the file is shaped.
 *
 * Postcode plus name is the strongest signal, but a feed with no postcode
 * column used to skip the check entirely — which meant a removal request
 * could be undone by importing a file that happened to omit one field. With
 * no postcode we fall back to the name plus a contact point that identifies
 * the same business. Name alone is not enough: two unrelated "The Old Barn"s
 * exist and suppressing both is its own harm.
 */
export async function checkSuppressed(tx: Db, row: ImportRow): Promise<boolean> {
  const nameMatch = eq(suppressions.nameNormalised, normaliseName(row.name));

  let identity: SQL | undefined;
  if (row.postcode) {
    identity = eq(suppressions.postcodeNormalised, normalisePostcode(row.postcode));
  } else {
    const contact: SQL[] = [];
    if (row.phone) {
      contact.push(sql`${phoneDigits(suppressions.phone)} = ${normalisePhone(row.phone)}`);
    }
    if (row.email) {
      contact.push(sql`lower(trim(${suppressions.email})) = ${row.email.trim().toLowerCase()}`);
    }
    if (contact.length === 0) return false;
    identity = or(...contact)!;
  }

  const [hit] = await tx
    .select({ id: suppressions.id })
    .from(suppressions)
    .where(and(nameMatch, identity))
    .limit(1);
  return hit !== undefined;
}

/**
 * Both halves of the match are normalised IN SQL.
 *
 * The suppression list has always compared normalised names and postcodes, so
 * a duplicate check that compared them literally let "THE OLD BARN" through as
 * a new business while the suppression list treated it as the same one — two
 * guardrails disagreeing about identity.
 */
export async function findDuplicate(
  tx: Db,
  row: ImportRow,
): Promise<{ listingId: string; reason: string } | null> {
  const clauses: SQL[] = [];
  if (row.postcode) {
    clauses.push(
      and(
        sql`lower(trim(${listings.name})) = ${row.name.trim().toLowerCase()}`,
        sql`lower(regexp_replace(coalesce(${listings.postcode}, ''), '[\\s-]+', '', 'g')) = ${normalisePostcode(row.postcode)}`,
      )!,
    );
  }
  if (row.phone) {
    clauses.push(sql`${phoneDigits(listings.phone)} = ${normalisePhone(row.phone)}`);
  }
  if (clauses.length === 0) return null;

  const [hit] = await tx
    .select({ id: listings.id, phone: listings.phone })
    .from(listings)
    .where(or(...clauses))
    .limit(1);
  if (!hit) return null;

  const phoneMatches =
    row.phone !== undefined &&
    hit.phone !== null &&
    normalisePhone(hit.phone) === normalisePhone(row.phone);
  return {
    listingId: hit.id,
    reason: phoneMatches ? "matching phone" : "matching name and postcode",
  };
}

/** Returns the city the row landed in, so the caller can refresh its gate. */
async function insertImportedListing(
  tx: Db,
  row: ImportRow,
  opts: { source: "scraped" | "import"; description: string | null },
): Promise<string> {
  const cityId = await resolveImportCity(tx, row);
  const [category] = await tx.select({ id: categories.id, verticalId: categories.verticalId })
    .from(categories).where(eq(categories.name, row.category)).limit(1);
  if (!category) throw new Error(`Unknown category "${row.category}" for "${row.name}"`);

  const id = randomUUID();
  const slug = await allocateSlug(tx, {
    parentScope: cityId, desired: row.name, kind: "listing", entityId: id,
  });
  await tx.insert(listings).values({
    id,
    name: row.name,
    slug,
    cityId,
    verticalId: category.verticalId,
    primaryCategoryId: category.id,
    status: "published",
    tier: "free",
    // Imported listings are NEVER verified and NEVER rated, in either mode.
    claimStatus: "unclaimed",
    source: opts.source,
    sourceUrl: row.sourceUrl ?? null,
    importedAt: now(),
    addressLine1: row.addressLine1 ?? null,
    postcode: row.postcode ?? null,
    phone: row.phone ?? null,
    email: row.email ?? null,
    website: row.website ?? null,
    description: opts.description,
    shortDescription:
      opts.description?.split(/(?<=\.)\s/)[0] ??
      `${row.name} is a ${row.category.toLowerCase().replace(/s$/, "")} in ${row.city}.`,
    publishedAt: now(),
  });
  return cityId;
}

export async function importRows(
  tx: Db,
  viewer: Viewer,
  rows: ImportRow[],
  opts: { dryRun: boolean; mode: ImportMode },
): Promise<ImportReport> {
  const report: ImportReport = {
    inserted: 0, duplicates: 0, suppressed: 0, rejected: 0, notes: [],
  };
  const touchedCities = new Set<string>();

  for (const row of rows) {
    const hasDescription = row.description !== undefined && row.description.trim() !== "";

    if (opts.mode === "scraped" && hasDescription) {
      report.rejected++;
      report.notes.push(`${row.name}: rejected — description present in a scraped import; facts only`);
      continue;
    }
    if (await checkSuppressed(tx, row)) {
      report.suppressed++;
      report.notes.push(`${row.name}: skipped — on the suppression list`);
      continue;
    }
    const dupe = await findDuplicate(tx, row);
    if (dupe) {
      report.duplicates++;
      report.notes.push(`${row.name}: skipped — likely duplicate of ${dupe.listingId} (${dupe.reason})`);
      continue;
    }

    report.inserted++;
    if (opts.dryRun) continue;

    touchedCities.add(
      await insertImportedListing(tx, row, {
        source: opts.mode === "scraped" ? "scraped" : "import",
        description: opts.mode === "authored" && hasDescription ? row.description!.trim() : null,
      }),
    );
  }

  // An import is the main way a city crosses the threshold, and until this
  // ran nothing outside the seed ever moved the gate — a site could import
  // ten thousand listings and stay entirely noindexed.
  for (const cityId of touchedCities) {
    await recomputeCityIndexability(tx, viewer, cityId);
  }
  return report;
}
