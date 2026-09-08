import {
  pgTable, uuid, text, integer, boolean, timestamp, jsonb,
  doublePrecision, numeric, uniqueIndex, index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { base } from "./_base";
import { listingStatus, listingTier, claimStatus, listingSource } from "./enums";
import { cities, areas, verticals, categories } from "./geo";

export const listings = pgTable("listings", {
  ...base,
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  cityId: uuid("city_id").notNull().references(() => cities.id),
  areaId: uuid("area_id").references(() => areas.id),
  verticalId: uuid("vertical_id").notNull().references(() => verticals.id),
  primaryCategoryId: uuid("primary_category_id").notNull().references(() => categories.id),

  status: listingStatus("status").notNull().default("draft"),
  tier: listingTier("tier").notNull().default("free"),
  claimStatus: claimStatus("claim_status").notNull().default("unclaimed"),
  ownerId: uuid("owner_id"),

  // Contact details are NEVER tier-gated. Only richness is.
  addressLine1: text("address_line1"),
  addressLine2: text("address_line2"),
  postcode: text("postcode"),
  lat: doublePrecision("lat"),
  lng: doublePrecision("lng"),
  phone: text("phone"),
  email: text("email"),
  website: text("website"),
  socials: jsonb("socials"),

  shortDescription: text("short_description"),
  description: text("description"),
  /** Current offers, shown on tiers with showPricingAndOffers. */
  offers: text("offers"),
  openingHours: jsonb("opening_hours"),
  timezone: text("timezone"),
  customFields: jsonb("custom_fields"),
  priceRange: text("price_range"),

  rankBoost: integer("rank_boost").notNull().default(0),
  // Trigger-maintained. NEVER seeded and NEVER written by hand.
  ratingAvg: numeric("rating_avg", { precision: 2, scale: 1 }),
  ratingCount: integer("rating_count").notNull().default(0),

  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  // Tracks the subscription's current_period_end. Lapse, cancel or failed
  // payment drops claim_status back to 'claimed'.
  verifiedExpiresAt: timestamp("verified_expires_at", { withTimezone: true }),
  verifiedBy: uuid("verified_by"),
  verificationChecks: jsonb("verification_checks"),

  viewCount: integer("view_count").notNull().default(0),
  enquiryCount: integer("enquiry_count").notNull().default(0),

  source: listingSource("source").notNull().default("seed"),
  sourceUrl: text("source_url"),
  importedAt: timestamp("imported_at", { withTimezone: true }),
  submittedByEmail: text("submitted_by_email"),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  rejectedReason: text("rejected_reason"),
}, (t) => [
  uniqueIndex("listings_city_slug_key").on(t.cityId, t.slug),
  index("listings_status_idx").on(t.status),
  index("listings_city_status_idx").on(t.cityId, t.status),
  index("listings_vertical_status_idx").on(t.verticalId, t.status),
  index("listings_category_status_idx").on(t.primaryCategoryId, t.status),
  index("listings_owner_idx").on(t.ownerId),
  index("listings_geo_idx").on(t.lat, t.lng),
  // The area axis had no index at all, so every local-multi-vertical area
  // page was a sequential scan of the whole table.
  index("listings_area_status_idx").on(t.areaId, t.status),
  // The homepage featured row is premium-only and runs on every request that
  // misses the ISR cache. Premium is a few per cent of the table, so a
  // partial index is a fraction of the size of a full one.
  index("listings_premium_status_idx").on(t.status).where(sql`${t.tier} = 'premium'`),
  // The importer's duplicate check, expression for expression. Indexed on the
  // normalised forms because that is what findDuplicate compares — an index
  // on the raw columns would never be used.
  index("listings_dupe_name_postcode_idx").on(
    sql`lower(trim(${t.name}))`,
    sql`lower(regexp_replace(${t.postcode}, '[\\s-]+', '', 'g'))`,
  ),
  index("listings_dupe_phone_idx").on(sql`regexp_replace(${t.phone}, '[^0-9]', '', 'g')`),
]);

export const listingCategories = pgTable("listing_categories", {
  ...base,
  listingId: uuid("listing_id").notNull().references(() => listings.id, { onDelete: "cascade" }),
  categoryId: uuid("category_id").notNull().references(() => categories.id),
}, (t) => [uniqueIndex("listing_categories_key").on(t.listingId, t.categoryId)]);

export const listingImages = pgTable("listing_images", {
  ...base,
  listingId: uuid("listing_id").notNull().references(() => listings.id, { onDelete: "cascade" }),
  storagePath: text("storage_path").notNull(),
  /** { thumb, card, hero, full } -> R2 keys, written by the worker at upload time. */
  derivatives: jsonb("derivatives"),
  /**
   * How many times the worker has tried and failed. The job picks up any row
   * with no derivatives, so without a counter one corrupt upload was retried
   * every minute for ever, burning an R2 GET and a sharp decode each time.
   */
  derivativesAttempts: integer("derivatives_attempts").notNull().default(0),
  /** Why the last attempt failed, so a stuck image can be diagnosed. */
  derivativesError: text("derivatives_error"),
  alt: text("alt"),
  width: integer("width"),
  height: integer("height"),
  sortOrder: integer("sort_order").notNull().default(0),
  isPrimary: boolean("is_primary").notNull().default(false),
}, (t) => [index("listing_images_listing_idx").on(t.listingId, t.sortOrder)]);
