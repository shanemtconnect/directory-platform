import { and, eq, or, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { listings, suppressions, cities, categories, verticals } from "@/lib/db/schema";
import { allocateSlug, ROOT_SCOPE } from "@/lib/routing/slugs";
import { normalisePostcode } from "@/lib/geo/countries";
import { siteConfig } from "@/config/site.config";
import { now } from "@/lib/clock";
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
  category: string;
  addressLine1?: string;
  postcode?: string;
  phone?: string;
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

/** A suppressed business must stay suppressed however the postcode is retyped. */
export async function checkSuppressed(tx: Db, row: ImportRow): Promise<boolean> {
  if (!row.postcode) return false;
  const [hit] = await tx
    .select({ id: suppressions.id })
    .from(suppressions)
    .where(
      and(
        eq(suppressions.nameNormalised, normaliseName(row.name)),
        eq(suppressions.postcodeNormalised, normalisePostcode(row.postcode)),
      ),
    )
    .limit(1);
  return hit !== undefined;
}

export async function findDuplicate(
  tx: Db,
  row: ImportRow,
): Promise<{ listingId: string; reason: string } | null> {
  const clauses = [];
  if (row.postcode) {
    clauses.push(and(eq(listings.name, row.name), eq(listings.postcode, row.postcode)));
  }
  if (row.phone) {
    clauses.push(sql`regexp_replace(${listings.phone}, '[^0-9]', '', 'g') = ${normalisePhone(row.phone)}`);
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

async function insertImportedListing(
  tx: Db,
  row: ImportRow,
  opts: { source: "scraped" | "import"; description: string | null },
): Promise<void> {
  const [city] = await tx.select({ id: cities.id }).from(cities).where(eq(cities.name, row.city)).limit(1);
  const [category] = await tx.select({ id: categories.id, verticalId: categories.verticalId })
    .from(categories).where(eq(categories.name, row.category)).limit(1);
  if (!city || !category) throw new Error(`Unknown city or category for "${row.name}"`);

  const id = randomUUID();
  const slug = await allocateSlug(tx, {
    parentScope: city.id, desired: row.name, kind: "listing", entityId: id,
  });
  await tx.insert(listings).values({
    id,
    name: row.name,
    slug,
    cityId: city.id,
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
    website: row.website ?? null,
    description: opts.description,
    shortDescription:
      opts.description?.split(/(?<=\.)\s/)[0] ??
      `${row.name} is a ${row.category.toLowerCase().replace(/s$/, "")} in ${row.city}.`,
    publishedAt: now(),
  });
}

export async function importRows(
  tx: Db,
  rows: ImportRow[],
  opts: { dryRun: boolean; mode: ImportMode },
): Promise<ImportReport> {
  const report: ImportReport = {
    inserted: 0, duplicates: 0, suppressed: 0, rejected: 0, notes: [],
  };

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

    await insertImportedListing(tx, row, {
      source: opts.mode === "scraped" ? "scraped" : "import",
      description: opts.mode === "authored" && hasDescription ? row.description!.trim() : null,
    });
  }
  return report;
}
