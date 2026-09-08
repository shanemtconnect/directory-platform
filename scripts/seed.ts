import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { eq, and, isNull, sql } from "drizzle-orm";
import {
  verticals, cities, categories, listings, slugs,
} from "@/lib/db/schema";
import { allocateSlug, seedReservedSlugs, resolveSlug, ROOT_SCOPE } from "@/lib/routing/slugs";
import { slugify } from "@/lib/routing/slugify";
import { siteConfig } from "@/config/site.config";
import { recomputeCityIndexability } from "@/lib/db/queries/indexing";
import { PUBLIC_VIEWER } from "@/lib/db/viewer";
import type { TestDb } from "@/test/db";

/**
 * The seed set is named after the entity, not the niche.
 *
 * The folder is named after `siteConfig.entity.plural`, so a clone renames one
 * directory and `pnpm seed` keeps working with no argument. A literal niche
 * name written down here is exactly how the previous default ended up naming
 * one niche inside a script that is supposed to serve all of them.
 */
export const DEFAULT_NICHE = slugify(siteConfig.entity.plural);

function parseCsv(path: string): Record<string, string>[] {
  const text = readFileSync(path, "utf8").trim();
  const [headerLine, ...lines] = text.split("\n");
  if (!headerLine) return [];
  const headers = headerLine.split(",").map((h) => h.trim());
  return lines.map((line) => {
    // Seed CSVs are ours and contain no embedded commas or quotes; the
    // importer (which handles third-party files) uses a real parser.
    const cells = line.split(",");
    return Object.fromEntries(headers.map((h, i) => [h, (cells[i] ?? "").trim()]));
  });
}

/**
 * An absent cell is NULL, not "".
 *
 * `parseCsv` cannot return undefined — a missing column and an empty one both
 * arrive as "" — so `row["region"] ?? null` never nulls anything. An empty
 * string then renders an empty `<h2>` on /cities and a heading that reads
 * "Singapore, " with nothing after the comma.
 */
function cell(row: Record<string, string>, key: string): string | null {
  const value = row[key];
  return value === undefined || value === "" ? null : value;
}

const ESCAPES: Record<string, string> = {
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
};
const escapeHtml = (input: string): string => input.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);

/** Same key on both sides of the join: two Richmonds are two cities. */
const cityKey = (name: string, region: string | null): string => `${name}|${region ?? ""}`;

export interface SeedReport {
  cities: number;
  categories: number;
  listings: number;
  skipped: number;
}

/**
 * Per-city intro copy, generated from that city's own facts.
 *
 * The indexing gate (`is_indexable` needs `intro_html IS NOT NULL`) cannot tell
 * real copy from a placeholder, so a seed that writes `<p>Intro copy.</p>`
 * hands every city an indexable page it has not earned. Everything below is
 * either a fact from the row (name, region, the categories actually present)
 * or a noun from `siteConfig` — nothing niche-specific is written here, so a
 * plumber clone reads correctly with no edit.
 *
 * No listing count: this copy is rendered on the public pillar page and
 * stripped into its meta description, and `writeIntroCopy` only ever fills
 * `intro_html` where it is NULL — it never revisits a city once written. A
 * count baked in here is true at seed time and false the moment a listing is
 * added or unpublished afterwards.
 */
function buildIntroHtml(input: {
  city: string;
  region: string | null;
  /** Name of each category present, name-ordered. */
  categories: { name: string }[];
}): string {
  const e = siteConfig.entity;
  const place = escapeHtml(input.region ? `${input.city}, ${input.region}` : input.city);

  const named = input.categories.slice(0, 3);
  const list = new Intl.ListFormat(siteConfig.locale, { style: "long", type: "conjunction" })
    .format(named.map((c) => escapeHtml(c.name.toLowerCase())));

  const coverage = named.length > 0
    ? ` ${input.categories.length > named.length ? "Categories include" : "They include"} ${list}.`
    : "";

  return (
    `<p>${escapeHtml(siteConfig.name)} lists ${escapeHtml(e.plural)} in ${place}.` +
    `${coverage}</p>` +
    `<p>Every entry has its own page with an address, contact details and an enquiry form, ` +
    `so you can compare ${escapeHtml(e.plural)} in ${place} side by side before you get in touch.</p>`
  );
}

/**
 * Idempotent. Re-running adds nothing and changes nothing.
 *
 * Seeded listings carry NO rating, NO review and claim_status 'unclaimed'.
 * Seeded cities are NOT indexable — a city earns indexing by clearing the
 * listing threshold and having intro copy.
 */
export async function runSeed(tx: TestDb, niche: string = DEFAULT_NICHE): Promise<SeedReport> {
  const dir = join(process.cwd(), "seeds", niche);
  const report: SeedReport = { cities: 0, categories: 0, listings: 0, skipped: 0 };

  // Reserved slugs first, so a seeded city called "Pricing" fails loudly here
  // rather than silently shadowing a static route in production.
  await seedReservedSlugs(tx);

  // niche-national has exactly one implicit vertical; it never appears in a URL.
  const e = siteConfig.entity;
  let verticalId: string;
  const existingVertical = await resolveSlug(tx, ROOT_SCOPE, e.plural);
  if (existingVertical?.entityId) {
    verticalId = existingVertical.entityId;
  } else {
    verticalId = randomUUID();
    const vSlug = await allocateSlug(tx, {
      parentScope: ROOT_SCOPE, desired: e.Plural, kind: "vertical", entityId: verticalId,
    });
    await tx.insert(verticals).values({
      id: verticalId, name: e.Plural, slug: vSlug,
      singular: e.singular, plural: e.plural, ownerNoun: e.ownerNoun,
      schemaType: siteConfig.schema.listingType,
    });
  }

  // --- Cities ---
  // Keyed on name AND region: "Richmond" alone collapses the two of them onto
  // one id, and every listing in the other Richmond lands in the wrong city.
  const cityIdByKey = new Map<string, string>();
  for (const row of parseCsv(join(dir, "cities.csv"))) {
    const name = row["name"]!;
    const region = cell(row, "region");
    const existing = await tx.select({ id: cities.id }).from(cities)
      .where(and(
        eq(cities.name, name),
        region === null ? isNull(cities.region) : eq(cities.region, region),
      ))
      .limit(1);
    if (existing[0]) { cityIdByKey.set(cityKey(name, region), existing[0].id); report.skipped++; continue; }

    const id = randomUUID();
    const slug = await allocateSlug(tx, {
      parentScope: ROOT_SCOPE, desired: name, kind: "city", entityId: id,
      disambiguator: region ?? undefined,
    });
    await tx.insert(cities).values({
      id, name, slug, region, country: cell(row, "country") ?? siteConfig.country,
      lat: row["lat"] ? Number(row["lat"]) : null,
      lng: row["lng"] ? Number(row["lng"]) : null,
      population: row["population"] ? Number(row["population"]) : null,
      createdBy: "seed",
      isIndexable: false,
    });
    cityIdByKey.set(cityKey(name, region), id);
    report.cities++;
  }

  // --- Categories (global rows; per-city routing added with the listings) ---
  const categoryIdByName = new Map<string, string>();
  const categorySingularByName = new Map<string, string>();
  for (const row of parseCsv(join(dir, "categories.csv"))) {
    const name = row["name"]!;
    const singular = cell(row, "singular") ?? name;
    categorySingularByName.set(name, singular);

    const existing = await tx.select({ id: categories.id }).from(categories)
      .where(eq(categories.name, name)).limit(1);
    if (existing[0]) { categoryIdByName.set(name, existing[0].id); report.skipped++; continue; }

    const id = randomUUID();
    const slug = await allocateSlug(tx, {
      parentScope: ROOT_SCOPE, desired: name, kind: "category", entityId: id,
    });
    await tx.insert(categories).values({
      id, verticalId, name, slug,
      singular, plural: cell(row, "plural") ?? name.toLowerCase(),
      sortOrder: Number(row["sort_order"] ?? 0),
    });
    categoryIdByName.set(name, id);
    report.categories++;
  }

  // --- Listings ---
  const routedCategories = new Set<string>();
  for (const row of parseCsv(join(dir, "listings.csv"))) {
    const cityName = row["city"]!;
    const categoryName = row["category"]!;
    const cityId = cityIdByKey.get(cityKey(cityName, cell(row, "region")));
    const categoryId = categoryIdByName.get(categoryName);
    if (!cityId || !categoryId) { report.skipped++; continue; }

    const name = row["name"]!;
    const existing = await tx.select({ id: listings.id }).from(listings)
      .where(and(eq(listings.cityId, cityId), eq(listings.name, name))).limit(1);
    if (existing[0]) { report.skipped++; continue; }

    // /[city]/[category] needs a slug row per city the category appears in.
    const routeKey = `${cityId}:${categoryId}`;
    if (!routedCategories.has(routeKey)) {
      const already = await tx.select({ id: slugs.id }).from(slugs)
        .where(and(eq(slugs.parentScope, cityId), eq(slugs.entityId, categoryId))).limit(1);
      if (!already[0]) {
        await allocateSlug(tx, {
          parentScope: cityId, desired: categoryName, kind: "category", entityId: categoryId,
        });
      }
      routedCategories.add(routeKey);
    }

    const id = randomUUID();
    const slug = await allocateSlug(tx, {
      parentScope: cityId, desired: name, kind: "listing", entityId: id,
    });
    // Generated from structured fields only — never an imported string — and
    // from THIS row's city and category. The singular comes from the category
    // sheet rather than a `replace(/s$/, "")` guess, which happened to work on
    // the seeded labels and would mangle any irregular plural.
    const singular = categorySingularByName.get(categoryName) ?? categoryName;
    await tx.insert(listings).values({
      id, name, slug, cityId, verticalId, primaryCategoryId: categoryId,
      status: "published", tier: "free", claimStatus: "unclaimed", source: "seed",
      addressLine1: cell(row, "address_line1"),
      postcode: cell(row, "postcode"),
      phone: cell(row, "phone"),
      website: cell(row, "website"),
      shortDescription: `${name} is a ${singular} in ${cityName}.`,
      publishedAt: new Date(),
    });
    report.listings++;
  }

  // The denormalised count and the gate flag the pillar pages read. Goes
  // through the one helper rather than hand-rolled SQL, so the seed cannot
  // drift from the rule the importer and the approval flow apply.
  for (const cityId of cityIdByName.values()) {
    await recomputeCityIndexability(tx, PUBLIC_VIEWER, cityId);
  }

  await writeIntroCopy(tx);

  return report;
}

/**
 * Writes intro copy for cities that have none.
 *
 * Only where `intro_html IS NULL`, so re-running the seed never overwrites copy
 * an editor has since written by hand.
 */
async function writeIntroCopy(tx: TestDb): Promise<void> {
  const pending = await tx
    .select({
      id: cities.id, name: cities.name, region: cities.region,
    })
    .from(cities)
    .where(isNull(cities.introHtml));

  for (const city of pending) {
    const present = await tx
      .selectDistinct({ name: categories.name })
      .from(listings)
      .innerJoin(categories, eq(categories.id, listings.primaryCategoryId))
      .where(and(eq(listings.cityId, city.id), eq(listings.status, "published")))
      .orderBy(categories.name);

    await tx
      .update(cities)
      .set({
        introHtml: buildIntroHtml({
          city: city.name,
          region: city.region,
          categories: present,
        }),
      })
      .where(eq(cities.id, city.id));
  }
}
