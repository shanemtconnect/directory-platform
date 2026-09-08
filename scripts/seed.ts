import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { eq, and, sql } from "drizzle-orm";
import {
  verticals, cities, categories, listings, slugs,
} from "@/lib/db/schema";
import { allocateSlug, seedReservedSlugs, resolveSlug, ROOT_SCOPE } from "@/lib/routing/slugs";
import { siteConfig } from "@/config/site.config";
import type { TestDb } from "@/test/db";

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

export interface SeedReport {
  cities: number;
  categories: number;
  listings: number;
  skipped: number;
}

/**
 * Idempotent. Re-running adds nothing and changes nothing.
 *
 * Seeded listings carry NO rating, NO review and claim_status 'unclaimed'.
 * Seeded cities are NOT indexable — a city earns indexing by clearing the
 * listing threshold and having intro copy.
 */
export async function runSeed(tx: TestDb, niche: string): Promise<SeedReport> {
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
  const cityIdByName = new Map<string, string>();
  for (const row of parseCsv(join(dir, "cities.csv"))) {
    const name = row["name"]!;
    const region = row["region"] ?? null;
    const existing = await tx.select({ id: cities.id }).from(cities)
      .where(and(eq(cities.name, name), eq(cities.region, region ?? "")))
      .limit(1);
    if (existing[0]) { cityIdByName.set(name, existing[0].id); report.skipped++; continue; }

    const id = randomUUID();
    const slug = await allocateSlug(tx, {
      parentScope: ROOT_SCOPE, desired: name, kind: "city", entityId: id,
      disambiguator: region ?? undefined,
    });
    await tx.insert(cities).values({
      id, name, slug, region, country: row["country"] ?? siteConfig.country,
      lat: row["lat"] ? Number(row["lat"]) : null,
      lng: row["lng"] ? Number(row["lng"]) : null,
      population: row["population"] ? Number(row["population"]) : null,
      createdBy: "seed",
      isIndexable: false,
    });
    cityIdByName.set(name, id);
    report.cities++;
  }

  // --- Categories (global rows; per-city routing added with the listings) ---
  const categoryIdByName = new Map<string, string>();
  for (const row of parseCsv(join(dir, "categories.csv"))) {
    const name = row["name"]!;
    const existing = await tx.select({ id: categories.id }).from(categories)
      .where(eq(categories.name, name)).limit(1);
    if (existing[0]) { categoryIdByName.set(name, existing[0].id); report.skipped++; continue; }

    const id = randomUUID();
    const slug = await allocateSlug(tx, {
      parentScope: ROOT_SCOPE, desired: name, kind: "category", entityId: id,
    });
    await tx.insert(categories).values({
      id, verticalId, name, slug,
      singular: row["singular"] ?? name, plural: row["plural"] ?? name.toLowerCase(),
      sortOrder: Number(row["sort_order"] ?? 0),
    });
    categoryIdByName.set(name, id);
    report.categories++;
  }

  // --- Listings ---
  const routedCategories = new Set<string>();
  for (const row of parseCsv(join(dir, "listings.csv"))) {
    const cityId = cityIdByName.get(row["city"]!);
    const categoryId = categoryIdByName.get(row["category"]!);
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
          parentScope: cityId, desired: row["category"]!, kind: "category", entityId: categoryId,
        });
      }
      routedCategories.add(routeKey);
    }

    const id = randomUUID();
    const slug = await allocateSlug(tx, {
      parentScope: cityId, desired: name, kind: "listing", entityId: id,
    });
    await tx.insert(listings).values({
      id, name, slug, cityId, verticalId, primaryCategoryId: categoryId,
      status: "published", tier: "free", claimStatus: "unclaimed", source: "seed",
      addressLine1: row["address_line1"] || null,
      postcode: row["postcode"] || null,
      phone: row["phone"] || null,
      website: row["website"] || null,
      // Generated from structured fields only — never an imported string.
      shortDescription: `${name} is a ${row["category"]!.toLowerCase().replace(/s$/, "")} in ${row["city"]}.`,
      publishedAt: new Date(),
    });
    report.listings++;
  }

  // Denormalised count the pillar pages and the indexing gate both read.
  await tx.execute(sql`
    update cities c set listing_count = (
      select count(*) from listings l where l.city_id = c.id and l.status = 'published'
    )
  `);

  return report;
}
