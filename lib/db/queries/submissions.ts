import { and, eq, isNotNull, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { auditLog, categories, cities, listings } from "@/lib/db/schema";
import { findDuplicate } from "@/lib/import/guardrails";
import { recomputeCityIndexability } from "@/lib/db/queries/indexing";
import { allocateSlug } from "@/lib/routing/slugs";
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
 * Written to audit_log when the submitted town is not one we hold.
 *
 * There is no submissions table and `listings.city_id` is NOT NULL, so a
 * submission for an unknown town cannot become a listing row without creating
 * the city first — and creating cities from unauthenticated input is exactly
 * how a directory ends up with "Lodnon" and a thin, unindexable page for it.
 * Parking the payload keeps the submission durable and puts city creation
 * where it belongs: behind admin approval.
 */
export const PARKED_SUBMISSION_ACTION = "listing_submission.pending_city";

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
 * Resolves the typed town to a city we already hold. Returns null — never a
 * new city — when there is no confident match.
 *
 * Two cities can share a name (Newport, Richmond), which is the entire reason
 * the form asks for a region. Ambiguity without a region resolves to null and
 * goes to admin rather than guessing a county and filing the listing under the
 * wrong pillar page.
 */
export async function resolveSubmittedCity(
  tx: TestDb,
  city: string,
  region: string | null,
): Promise<string | null> {
  const wanted = city.trim().toLowerCase();
  if (wanted === "") return null;

  const rows = await tx
    .select({ id: cities.id, region: cities.region })
    .from(cities)
    .where(sql`lower(${cities.name}) = ${wanted}`);

  if (rows.length === 0) return null;

  if (region !== null && region.trim() !== "") {
    const wantedRegion = region.trim().toLowerCase();
    const exact = rows.find((r) => r.region?.toLowerCase() === wantedRegion);
    return exact?.id ?? null;
  }
  return rows.length === 1 ? (rows[0]?.id ?? null) : null;
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

  const cityId = await resolveSubmittedCity(tx, input.city, input.region);
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
