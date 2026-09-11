import { and, eq, isNotNull, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { auditLog, categories, cities, listings } from "@/lib/db/schema";
import { findDuplicate } from "@/lib/import/guardrails";
import { recomputeCityIndexability } from "@/lib/db/queries/indexing";
import { ROOT_SCOPE, SlugError, allocateSlug } from "@/lib/routing/slugs";
import { geocodeCity } from "@/lib/geo/geocode";
import { siteConfig } from "@/config/site.config";
import { now } from "@/lib/clock";
import type { TierName } from "@/config/types";
import { isAdmin, type Viewer } from "@/lib/db/viewer";
import type { listingStatus } from "@/lib/db/schema/enums";
import type { TestDb } from "@/test/db";

/**
 * Public submissions from /add-listing.
 *
 * A submission is a `listings` row in `status: 'pending'` — not a separate
 * entity — so admin approval is a status change rather than a copy step, and
 * the duplicate, suppression and slug rules that govern imports govern
 * submissions too. Nothing here publishes, rates or verifies anything.
 */

export interface SubmissionInput {
  name: string;
  categoryId: string;
  /** Disambiguation only. Never a URL segment; see cities.region. */
  region: string | null;
  /** As typed by the submitter. May not match any city we hold yet. */
  city: string;
  addressLine1: string;
  postcode: string;
  phone: string;
  website: string | null;
  description: string;
  submitterName: string;
  submitterEmail: string;
  /** What they asked for, NOT what they get. See createSubmission. */
  requestedTier: TierName;
  /** Null when no proxy header identified the submitter. Never a placeholder. */
  ip: string | null;
}

export interface SubmissionOptions {
  categories: { id: string; name: string }[];
  regions: string[];
}

/**
 * What the submitter is allowed to know about a match.
 *
 * 'match' names the listing and points at its live page. 'pending' says only
 * that we already hold something: an unpublished row's name and slug are not
 * public, and a form that returned them would be a lookup tool — type a phone
 * number, read back a listing nobody is meant to see yet.
 */
export type DuplicateMatch =
  | {
      kind: "match";
      listingId: string;
      name: string;
      /** Listing slug. Per city, so it is only a URL alongside citySlug. */
      slug: string;
      citySlug: string;
      reason: string;
    }
  | { kind: "pending" };

export type SubmissionResult =
  | { outcome: "created"; listingId: string; slug: string }
  | { outcome: "parked"; parkedId: string }
  | { outcome: "unknown-category" };

/**
 * Written to audit_log when the submitted town cannot be resolved to ONE city.
 *
 * A name we have never seen is now created (see `createAutoCity`). What is
 * still parked is the case creating a city cannot answer: a name we already
 * hold in a region other than the one typed — "Newport" with no county, or
 * "Leeds, Kent". Guessing there files the listing under the wrong pillar page
 * or mints a near-twin of a city we already have, and only an admin looking at
 * the address can tell which. Parking keeps the submission durable meanwhile.
 */
export const PARKED_SUBMISSION_ACTION = "listing_submission.pending_city";

/** Written to audit_log when a submission brings a town we did not hold. */
export const AUTO_CITY_ACTION = "city.auto_created";

/** The selects on the form. Public taxonomy, so nothing is viewer-gated. */
export async function submissionOptions(
  tx: TestDb,
  _viewer: Viewer,
): Promise<SubmissionOptions> {
  const cats = await tx
    .select({ id: categories.id, name: categories.name })
    .from(categories)
    .where(eq(categories.isActive, true))
    .orderBy(categories.sortOrder, categories.name);

  const regionRows = await tx
    .selectDistinct({ region: cities.region })
    .from(cities)
    .where(and(eq(cities.isPublished, true), isNotNull(cities.region)))
    .orderBy(cities.region);

  return {
    categories: cats,
    regions: regionRows.map((r) => r.region).filter((r): r is string => r !== null),
  };
}

/**
 * What the typed town is: one city we hold, a name we have never seen, or a
 * question only an admin can answer.
 *
 * `new` is the permission to create. It is given ONLY when nothing we hold
 * shares the name, because that is the one case where creating a city cannot
 * collide with an existing pillar page. Everything else is `ambiguous`:
 * two Newports and no county, or a Leeds in a county we do not have it in.
 * The second of those looks like a new town and is far more often a mistyped
 * county, so it goes to a human rather than minting a near-twin city that then
 * splits a town's listings across two pages.
 */
export type CityResolution =
  | { kind: "found"; cityId: string }
  | { kind: "ambiguous" }
  | { kind: "new" };

export async function resolveSubmittedCity(
  tx: TestDb,
  city: string,
  region: string | null,
): Promise<CityResolution> {
  const wanted = city.trim().toLowerCase();
  // An empty name is not a new city, it is no city at all.
  if (wanted === "") return { kind: "ambiguous" };

  const rows = await tx
    .select({ id: cities.id, region: cities.region })
    .from(cities)
    .where(sql`lower(${cities.name}) = ${wanted}`);

  if (rows.length === 0) return { kind: "new" };

  if (region !== null && region.trim() !== "") {
    const wantedRegion = region.trim().toLowerCase();
    const exact = rows.find((r) => r.region?.toLowerCase() === wantedRegion);
    return exact ? { kind: "found", cityId: exact.id } : { kind: "ambiguous" };
  }
  const only = rows.length === 1 ? rows[0] : undefined;
  return only ? { kind: "found", cityId: only.id } : { kind: "ambiguous" };
}

/**
 * Creates the city a submission brought with it, or returns null when the name
 * cannot be a root slug.
 *
 * Published so the page renders — a submitter who is told their listing is
 * filed in Otley should be able to see Otley — and `is_indexable = false` with
 * no intro copy so it earns nothing: it is out of the sitemap, out of the
 * footer, out of every internal-linking block, and carries `noindex` until it
 * clears the gate on its own terms. Global constraint 9 is not bypassed here;
 * it is simply not met yet, and `recomputeCityIndexability` is what will
 * notice when it is.
 *
 * `lat`/`lng` are null rather than guessed. `geocodeCity` is a no-op today and
 * says so; the reason is written to the audit row so "why has this city no
 * coordinates?" has an answer that does not require reading this comment.
 *
 * Returns null for a name `allocateSlug` refuses — a reserved root slug
 * ("Search"), or a name with nothing slug-able in it. Those submissions park.
 * A SlugError thrown out of here would 500 the form for a typo.
 */
async function createAutoCity(
  tx: TestDb,
  input: { name: string; region: string | null; ip: string | null },
): Promise<string | null> {
  const id = randomUUID();
  const name = input.name.trim();
  const region = input.region?.trim() || null;

  let slug: string;
  try {
    slug = await allocateSlug(tx, {
      parentScope: ROOT_SCOPE,
      desired: name,
      kind: "city",
      entityId: id,
      // Two towns of the same name are ambiguous and never reach here, so this
      // only disambiguates against a non-city slug that took the name first.
      ...(region === null ? {} : { disambiguator: region }),
    });
  } catch (error) {
    if (error instanceof SlugError) return null;
    throw error;
  }

  const located = await geocodeCity({ name, region, country: siteConfig.country });

  await tx.insert(cities).values({
    id,
    name,
    slug,
    region,
    country: siteConfig.country,
    lat: located.point?.lat ?? null,
    lng: located.point?.lng ?? null,
    isPublished: true,
    isIndexable: false,
    introHtml: null,
    createdBy: "auto",
  });

  await tx.insert(auditLog).values({
    action: AUTO_CITY_ACTION,
    entityType: "city",
    entityId: id,
    meta: { name, region, slug, geocode: located.reason },
    ip: input.ip,
  });

  return id;
}

/**
 * Reuses the import guardrail rather than repeating its matching rules, so a
 * business submitted by hand is judged a duplicate on exactly the same terms
 * as one arriving in a feed: matching name and postcode, or a phone number
 * that normalises to the same digits.
 *
 * The match itself runs over every listing — a second row for a business that
 * is merely pending is still a duplicate — but only an admin is told which
 * one. Anyone else learns that a published listing exists, or nothing.
 */
export async function findSubmissionDuplicate(
  tx: TestDb,
  viewer: Viewer,
  input: Pick<SubmissionInput, "name" | "city" | "postcode" | "phone">,
): Promise<DuplicateMatch | null> {
  const hit = await findDuplicate(tx, viewer, {
    name: input.name.trim(),
    city: input.city.trim(),
    // findDuplicate reads only name, postcode and phone; category is part of
    // the shared ImportRow shape and is not used in the match.
    category: "",
    postcode: input.postcode.trim(),
    phone: input.phone.trim(),
  });
  if (!hit) return null;

  const [row] = await tx
    .select({
      name: listings.name,
      slug: listings.slug,
      status: listings.status,
      citySlug: cities.slug,
    })
    .from(listings)
    .innerJoin(cities, eq(cities.id, listings.cityId))
    .where(eq(listings.id, hit.listingId))
    .limit(1);
  if (!row) return null;

  if (row.status !== "published" && !isAdmin(viewer)) return { kind: "pending" };

  return {
    kind: "match",
    listingId: hit.listingId,
    name: row.name,
    slug: row.slug,
    citySlug: row.citySlug,
    reason: hit.reason,
  };
}

/**
 * Files the submission. Always pending, never live.
 *
 * The chosen tier is recorded as a REQUEST in custom_fields and the row stays
 * on `free`: no payment is taken at submission, and writing the paid tier here
 * would hand out paid placement to anyone who can fill in a form. Approval
 * emails the trial link; the tier changes when the subscription activates.
 */
export async function createSubmission(
  tx: TestDb,
  viewer: Viewer,
  input: SubmissionInput,
): Promise<SubmissionResult> {
  const [category] = await tx
    .select({ id: categories.id, verticalId: categories.verticalId })
    .from(categories)
    .where(and(eq(categories.id, input.categoryId), eq(categories.isActive, true)))
    .limit(1);
  if (!category) return { outcome: "unknown-category" };

  const submission = {
    submittedCity: input.city.trim(),
    submittedRegion: input.region?.trim() ?? null,
    requestedTier: input.requestedTier,
    submitterName: input.submitterName.trim(),
    submitterEmail: input.submitterEmail.trim(),
    submittedAt: now().toISOString(),
    ip: input.ip,
  };

  // An unknown town is created rather than parked: a submission that names a
  // place we do not cover is the cheapest signal there is that we should, and
  // the new city earns nothing by existing (see createAutoCity).
  const resolved = await resolveSubmittedCity(tx, input.city, input.region);
  const cityId =
    resolved.kind === "found"
      ? resolved.cityId
      : resolved.kind === "new"
        ? await createAutoCity(tx, { name: input.city, region: input.region, ip: input.ip })
        : null;

  if (cityId === null) {
    // ip is recorded once, on the audit row's own column.
    const { ip: _ip, ...payload } = input;
    const [parked] = await tx
      .insert(auditLog)
      .values({
        action: PARKED_SUBMISSION_ACTION,
        entityType: "listing_submission",
        meta: { ...submission, listing: payload },
        ip: input.ip,
      })
      .returning({ id: auditLog.id });
    return { outcome: "parked", parkedId: parked!.id };
  }

  const id = randomUUID();
  const slug = await allocateSlug(tx, {
    parentScope: cityId,
    desired: input.name.trim(),
    kind: "listing",
    entityId: id,
  });

  await tx.insert(listings).values({
    id,
    name: input.name.trim(),
    slug,
    cityId,
    verticalId: category.verticalId,
    primaryCategoryId: category.id,
    status: "pending",
    tier: "free",
    claimStatus: "unclaimed",
    source: "public",
    addressLine1: input.addressLine1.trim(),
    postcode: input.postcode.trim(),
    phone: input.phone.trim(),
    website: input.website,
    description: input.description.trim(),
    // The submitter's address is who to reply to, not a published contact for
    // the business. It stays out of listings.email until approval confirms it.
    submittedByEmail: input.submitterEmail.trim(),
    // Left untouched on purpose: ratingAvg, verifiedAt, publishedAt. A rating
    // comes from reviews and verification comes from a passed check — neither
    // can be self-declared on a form.
    customFields: { submission },
  });

  // Global constraint 9: the gate is recomputed by whatever changes a listing's
  // status or city, in the SAME transaction as the change. A submission files a
  // `pending` row, so today this cannot move the count — and that is exactly
  // why it is here. The rule is "every write path recomputes", not "the write
  // paths we think can matter recompute": the day a submission lands published,
  // or a city's threshold changes underneath it, this is already correct.
  await recomputeCityIndexability(tx, viewer, cityId);

  return { outcome: "created", listingId: id, slug };
}

export type ListingStatus = (typeof listingStatus.enumValues)[number];

export type StatusChange =
  | { outcome: "changed"; listingId: string; from: ListingStatus; to: ListingStatus }
  | { outcome: "unknown-listing" }
  | { outcome: "forbidden" };

/**
 * THE status change. Approval, rejection, publication and takedown are all this
 * one function, because all four are the same event to the indexing gate.
 *
 * The status write and `recomputeCityIndexability` run on the same handle, so a
 * caller that wraps them in a transaction gets both or neither. A city cannot
 * end up advertising a listing count it does not have, which is what a status
 * change that forgot to recompute used to leave behind: the third listing in a
 * city would publish, the city would stay `is_indexable = false`, and the
 * pillar page would carry `noindex` for ever with nothing to trigger a retry.
 *
 * Admin only. Status is the difference between a moderation queue and the open
 * web, so it is not something a viewer can change on their own behalf.
 */
export async function setListingStatus(
  tx: TestDb,
  viewer: Viewer,
  listingId: string,
  status: ListingStatus,
): Promise<StatusChange> {
  if (!isAdmin(viewer)) return { outcome: "forbidden" };

  const [before] = await tx
    .select({
      id: listings.id,
      status: listings.status,
      cityId: listings.cityId,
      publishedAt: listings.publishedAt,
    })
    .from(listings)
    .where(eq(listings.id, listingId))
    .limit(1);
  if (!before) return { outcome: "unknown-listing" };

  await tx
    .update(listings)
    .set({
      status,
      updatedAt: now(),
      // Stamped once, the first time it goes live, and keyed on the column
      // rather than on the previous status. A republish after a takedown is
      // not a new publication date, and rewriting it would reorder the site's
      // own "recently added" every time a moderator toggled something.
      ...(status === "published" && before.publishedAt === null
        ? { publishedAt: now() }
        : {}),
    })
    .where(eq(listings.id, listingId));

  await recomputeCityIndexability(tx, viewer, before.cityId);

  return { outcome: "changed", listingId, from: before.status, to: status };
}
