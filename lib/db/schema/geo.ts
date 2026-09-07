import {
  pgTable, uuid, text, integer, boolean, jsonb,
  doublePrecision, uniqueIndex, index,
} from "drizzle-orm/pg-core";
import { base } from "./_base";
import { slugKind, cityCreatedBy } from "./enums";

/**
 * The router's index AND the database-level collision guard.
 *
 * `parentScope` is the literal 'root' (cities, verticals, reserved static
 * routes) or the uuid of the owning city/vertical (categories, areas,
 * listings). One unique constraint makes every slug collision impossible —
 * including a listing trying to take a category's slug inside the same city,
 * which no amount of resolution ordering can fix on its own.
 */
export const slugs = pgTable("slugs", {
  ...base,
  parentScope: text("parent_scope").notNull(),
  slug: text("slug").notNull(),
  kind: slugKind("kind").notNull(),
  entityId: uuid("entity_id"),
}, (t) => [
  uniqueIndex("slugs_scope_slug_key").on(t.parentScope, t.slug),
  index("slugs_entity_idx").on(t.kind, t.entityId),
]);

/** niche-national has exactly one implicit row and it never appears in a URL. */
export const verticals = pgTable("verticals", {
  ...base,
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  singular: text("singular").notNull(),
  plural: text("plural").notNull(),
  ownerNoun: text("owner_noun").notNull(),
  schemaType: text("schema_type").notNull(),
  icon: text("icon"),
  introHtml: text("intro_html"),
  sortOrder: integer("sort_order").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
}, (t) => [uniqueIndex("verticals_slug_key").on(t.slug)]);

export const cities = pgTable("cities", {
  ...base,
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  /** County/state. Disambiguation and schema.org only — never a URL segment. */
  region: text("region"),
  country: text("country").notNull(),
  lat: doublePrecision("lat"),
  lng: doublePrecision("lng"),
  population: integer("population"),
  introHtml: text("intro_html"),
  faq: jsonb("faq"),
  metaTitle: text("meta_title"),
  metaDescription: text("meta_description"),
  heroImageUrl: text("hero_image_url"),
  isPublished: boolean("is_published").notNull().default(true),
  /**
   * Defaults FALSE. A city earns indexing by clearing the listing threshold and
   * having intro copy; it is never granted. This default is the whole defence
   * against thin city pages dragging the domain down.
   */
  isIndexable: boolean("is_indexable").notNull().default(false),
  listingCount: integer("listing_count").notNull().default(0),
  createdBy: cityCreatedBy("created_by").notNull().default("seed"),
}, (t) => [
  uniqueIndex("cities_slug_key").on(t.slug),
  index("cities_geo_idx").on(t.lat, t.lng),
  index("cities_indexable_idx").on(t.isIndexable),
]);

/** local-multi-vertical only. Unused table on niche-national sites. */
export const areas = pgTable("areas", {
  ...base,
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  lat: doublePrecision("lat"),
  lng: doublePrecision("lng"),
  introHtml: text("intro_html"),
  faq: jsonb("faq"),
  metaTitle: text("meta_title"),
  metaDescription: text("meta_description"),
  isPublished: boolean("is_published").notNull().default(true),
  isIndexable: boolean("is_indexable").notNull().default(false),
  listingCount: integer("listing_count").notNull().default(0),
}, (t) => [uniqueIndex("areas_slug_key").on(t.slug)]);

export const categories = pgTable("categories", {
  ...base,
  verticalId: uuid("vertical_id").notNull().references(() => verticals.id),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  singular: text("singular").notNull(),
  plural: text("plural").notNull(),
  description: text("description"),
  icon: text("icon"),
  schemaTypeOverride: text("schema_type_override"),
  parentId: uuid("parent_id"),
  sortOrder: integer("sort_order").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
}, (t) => [
  uniqueIndex("categories_slug_key").on(t.slug),
  index("categories_vertical_idx").on(t.verticalId),
]);
