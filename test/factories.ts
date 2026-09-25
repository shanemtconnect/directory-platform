import { randomUUID } from "node:crypto";
import { verticals, cities, categories, listings, areas } from "@/lib/db/schema";
import { allocateSlug, ROOT_SCOPE } from "@/lib/routing/slugs";
import type { TestDb } from "./db";

export async function makeVertical(tx: TestDb, name = "Venues"): Promise<string> {
  const id = randomUUID();
  const slug = await allocateSlug(tx, {
    parentScope: ROOT_SCOPE, desired: name, kind: "vertical", entityId: id,
  });
  await tx.insert(verticals).values({
    id, name, slug, singular: "venue", plural: "venues",
    ownerNoun: "venue owner", schemaType: "EventVenue",
  });
  return id;
}

/** `region: null` is the shape an auto-created city has — see createAutoCity. */
export async function makeCity(
  tx: TestDb, name = "Leeds", region: string | null = "West Yorkshire",
): Promise<string> {
  const id = randomUUID();
  const slug = await allocateSlug(tx, {
    parentScope: ROOT_SCOPE, desired: name, kind: "city", entityId: id,
    ...(region === null ? {} : { disambiguator: region }),
  });
  await tx.insert(cities).values({ id, name, slug, region, country: "GB" });
  return id;
}

/**
 * Categories are GLOBAL taxonomy: one row, one national page at
 * /categories/[slug]. The per-city routing entry is a separate slug-registry
 * row pointing at the same category — see linkCategoryToCity.
 */
export async function makeCategory(
  tx: TestDb, verticalId: string, name = "Barn Venues",
): Promise<string> {
  const id = randomUUID();
  const slug = await allocateSlug(tx, {
    parentScope: ROOT_SCOPE, desired: name, kind: "category", entityId: id,
  });
  await tx.insert(categories).values({
    id, verticalId, name, slug,
    singular: name.toLowerCase().replace(/s$/, ""), plural: name.toLowerCase(),
  });
  return id;
}

/** Makes /[city]/[category] resolve. One category can be linked to many cities. */
export async function linkCategoryToCity(
  tx: TestDb, categoryId: string, cityId: string, name: string,
): Promise<string> {
  return allocateSlug(tx, {
    parentScope: cityId, desired: name, kind: "category", entityId: categoryId,
  });
}

/** Create a global category and route it in one city. */
export async function makeCategoryInCity(
  tx: TestDb, verticalId: string, cityId: string, name = "Barn Venues",
): Promise<string> {
  const id = await makeCategory(tx, verticalId, name);
  await linkCategoryToCity(tx, id, cityId, name);
  return id;
}

export interface ListingCtx {
  cityId: string;
  verticalId: string;
  primaryCategoryId: string;
}

export async function makeListing(
  tx: TestDb,
  ctx: ListingCtx,
  patch: Partial<typeof listings.$inferInsert> = {},
): Promise<string> {
  const id = randomUUID();
  const name = patch.name ?? `Listing ${id.slice(0, 8)}`;
  const slug = await allocateSlug(tx, {
    parentScope: ctx.cityId, desired: name, kind: "listing", entityId: id,
  });
  await tx.insert(listings).values({
    id, name, slug, ...ctx,
    status: "published", tier: "free", claimStatus: "unclaimed", source: "seed",
    ...patch,
  });
  return id;
}

/** A city with a vertical and a category, ready for listings. */
export async function makeScaffold(tx: TestDb): Promise<ListingCtx> {
  const verticalId = await makeVertical(tx);
  const cityId = await makeCity(tx);
  const primaryCategoryId = await makeCategoryInCity(tx, verticalId, cityId);
  return { cityId, verticalId, primaryCategoryId };
}

/**
 * A neighbourhood under a town (Task 52): an `areas` row with `city_id`, its
 * slug registered in the town's scope so /<city>/<slug> resolves.
 */
export async function makeNeighbourhood(
  tx: TestDb,
  cityId: string,
  name = "Headingley",
  patch: Partial<typeof areas.$inferInsert> = {},
): Promise<string> {
  const id = randomUUID();
  const slug = await allocateSlug(tx, { parentScope: cityId, desired: name, kind: "area", entityId: id });
  await tx.insert(areas).values({
    id, name, slug, cityId, lat: 53.8, lng: -1.55, radiusKm: 2, isPublished: true, ...patch,
  });
  return id;
}
