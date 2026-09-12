import { randomBytes } from "node:crypto";
import { and, count, desc, eq, sql } from "drizzle-orm";
import {
  auditLog, cities, listings, profiles, reviews, reviewInvites, reviewReplies,
} from "@/lib/db/schema";
import { now } from "@/lib/clock";
import { isAdmin, type Viewer } from "@/lib/db/viewer";
import { publishedListings } from "@/lib/db/queries/listings";
import { flagReview } from "@/lib/reviews/moderation";
import type { TestDb } from "@/test/db";

/**
 * Every read and write of a review.
 *
 * The rule the whole module exists to enforce is that a rating on this site is
 * real or it is absent. Three things follow from it and all three live here:
 *
 *  - A review counts towards `listings.rating_avg` / `rating_count` only once
 *    it is `published`, and those two columns are never written by anything
 *    except `recomputeListingRating` — never seeded, never set by hand, never
 *    incremented optimistically on submit.
 *  - A review is `published` only after the address that wrote it clicked a
 *    link sent to it, and only if the moderation heuristics do not hold it.
 *  - A listing's owner cannot write one, by account or by contact address.
 *
 * Personal data: `author_email` and `ip` are on the row because moderation and
 * the one-per-listing rule need them, and they are NEVER in a public
 * projection — see `publicReviewColumns`.
 */

export const REVIEWS_PER_PAGE = 10;

/** How many reviews the listing page shows before linking to the rest. */
export const SUMMARY_REVIEWS = 3;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 32 bytes of randomness, url-safe.
 *
 * The token IS the proof of address, so it has to be unguessable: anything
 * derived from the review id or the email would let one person verify
 * another's review, and a published review moves a business's public rating.
 */
function mintToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * How long a verification link lives.
 *
 * A token that never expires is a standing permission to move a business's
 * public rating, sitting in a mailbox forever: a review written and abandoned
 * in March can be published in November by whoever ends up with that inbox,
 * long after the thing being described stopped being true. Seven days is the
 * span in which somebody who meant to confirm still will — after that the
 * honest answer is to send a new link rather than honour an old one.
 *
 * Deliberately much longer than the claim link's thirty minutes: a claim hands
 * over a business, and this only publishes an opinion about one.
 */
export const REVIEW_TOKEN_TTL_DAYS = 7;

const TTL_MS = REVIEW_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000;

/**
 * `sentAt` is null for an invite nobody can date. That is not "never expires":
 * the only invite this module writes always carries one, so a null here is a
 * row of unknown provenance and the safe reading is that it is too old.
 */
function isInviteExpired(sentAt: Date | null): boolean {
  if (sentAt === null) return true;
  return now().getTime() - sentAt.getTime() > TTL_MS;
}

/* ------------------------------------------------------------- projections */

/**
 * What a reader is allowed to see of a review.
 *
 * `author_email` is the address that wrote it and `ip` is where from; both are
 * on the row because the unique index and the moderation queue need them, and
 * neither has any business inside the RSC payload of a public page. Same rule
 * as `publicListingColumns`: project what the page renders, nothing else.
 */
export const publicReviewColumns = {
  id: reviews.id,
  createdAt: reviews.createdAt,
  rating: reviews.rating,
  subRatings: reviews.subRatings,
  title: reviews.title,
  body: reviews.body,
  displayName: reviews.authorDisplayName,
} as const;

export interface PublicReview {
  id: string;
  createdAt: Date;
  rating: number;
  subRatings: unknown;
  title: string | null;
  body: string | null;
  displayName: string | null;
  /** The owner's published answer, or null. */
  reply: string | null;
  repliedAt: Date | null;
}

/* -------------------------------------------------------------------- write */

export interface ReviewInput {
  listingId: string;
  rating: number;
  subRatings: Record<string, number> | null;
  title: string | null;
  body: string;
  displayName: string;
  /** Already lowercased by validation; the one-per-listing index is exact. */
  email: string;
  ip: string | null;
}

export type CreateReviewResult =
  | { outcome: "created"; reviewId: string; token: string }
  | { outcome: "unknown-listing" }
  | { outcome: "own-listing" }
  | { outcome: "already-reviewed" };

/** The profile row id behind a signed-in viewer, or null if there isn't one. */
async function profileIdOf(tx: TestDb, viewer: Viewer): Promise<string | null> {
  if (viewer.role === "public") return null;
  const [row] = await tx
    .select({ id: profiles.id })
    .from(profiles)
    .where(eq(profiles.userId, viewer.userId))
    .limit(1);
  return row?.id ?? null;
}

/**
 * Writes a pending review and the single-use token that will verify it.
 *
 * Nothing about the listing's rating changes here. A review that is submitted
 * and never verified must leave no trace on the public page, which is exactly
 * what most bulk review spam is.
 */
export async function createReview(
  tx: TestDb,
  viewer: Viewer,
  input: ReviewInput,
): Promise<CreateReviewResult> {
  if (!UUID.test(input.listingId)) return { outcome: "unknown-listing" };

  // Published-only, like every other public write: a pending or removed
  // listing must not accumulate reviews nobody can see.
  const [target] = await tx
    .select({ id: listings.id, ownerId: listings.ownerId, email: listings.email })
    .from(listings)
    .where(and(eq(listings.id, input.listingId), publishedListings(viewer)))
    .limit(1);
  if (!target) return { outcome: "unknown-listing" };

  // Two ways the same person tries it: signed in as the owner, or using the
  // address printed on the listing. Neither is a customer's experience.
  const viewerProfileId = await profileIdOf(tx, viewer);
  if (viewerProfileId !== null && target.ownerId === viewerProfileId) {
    return { outcome: "own-listing" };
  }
  if (target.email !== null && target.email.trim().toLowerCase() === input.email) {
    return { outcome: "own-listing" };
  }

  // Insert-and-see rather than check-then-insert: the unique index is the
  // authority, and 23505 inside the caller's transaction would poison it.
  const inserted = await tx
    .insert(reviews)
    .values({
      listingId: input.listingId,
      authorEmail: input.email,
      authorDisplayName: input.displayName,
      rating: input.rating,
      subRatings: input.subRatings,
      title: input.title,
      body: input.body,
      status: "pending",
      ip: input.ip,
      // Explicit rather than defaultNow(): `now()` in Postgres is the
      // TRANSACTION timestamp, so a batch written together would all sort as
      // one instant, and `lib/clock` is the only sanctioned source of time.
      createdAt: now(),
      updatedAt: now(),
    })
    .onConflictDoNothing({ target: [reviews.listingId, reviews.authorEmail] })
    .returning({ id: reviews.id });

  const row = inserted[0];
  if (!row) return { outcome: "already-reviewed" };

  const token = mintToken();
  await tx.insert(reviewInvites).values({
    listingId: input.listingId,
    token,
    sentTo: input.email,
    sentAt: now(),
  });

  return { outcome: "created", reviewId: row.id, token };
}

/* ---------------------------------------------------------------- aggregate */

/**
 * THE only writer of `listings.rating_avg` / `rating_count`.
 *
 * Recomputed from the published rows rather than incremented, so no sequence
 * of verifications, rejections and restorations can leave the public number
 * disagreeing with the reviews underneath it. Called on every status change.
 */
export async function recomputeListingRating(tx: TestDb, listingId: string): Promise<void> {
  await tx
    .update(listings)
    .set({
      ratingAvg: sql`(
        select round(avg(${reviews.rating})::numeric, 1)
        from ${reviews}
        where ${reviews.listingId} = ${listingId} and ${reviews.status} = 'published'
      )`,
      ratingCount: sql`(
        select count(*)
        from ${reviews}
        where ${reviews.listingId} = ${listingId} and ${reviews.status} = 'published'
      )`,
      updatedAt: now(),
    })
    .where(eq(listings.id, listingId));
}

/* ------------------------------------------------------------------- verify */

export type VerifyReviewResult =
  | { outcome: "unknown-token" }
  /**
   * The link was real and is too old. Distinct from `unknown-token` because
   * the answer is different: there is a review sitting there waiting, and the
   * page can offer to send a fresh link rather than a dead end.
   */
  | { outcome: "expired"; reviewId: string; listingId: string; path: string }
  | {
      outcome: "verified";
      reviewId: string;
      listingId: string;
      /** Site-relative path of the listing the review is about. */
      path: string;
      status: "published" | "pending";
      flaggedReason: string | null;
      /** True when the link had already been used — a second click, not a fault. */
      repeat: boolean;
    };

/**
 * Turns a clicked link into a verified review.
 *
 * The token proves the address; the heuristics decide whether that is enough.
 * A held review keeps `email_verified_at` — the click happened, and a
 * moderator publishing it later should not have to re-prove the address.
 *
 * A second click is a repeat, not a dead link: people forward these, and a 404
 * on the second open reads as "your review was lost".
 */
export async function verifyReviewToken(
  tx: TestDb,
  _viewer: Viewer,
  token: string,
): Promise<VerifyReviewResult> {
  if (token.trim() === "") return { outcome: "unknown-token" };

  const [invite] = await tx
    .select({
      id: reviewInvites.id,
      listingId: reviewInvites.listingId,
      sentTo: reviewInvites.sentTo,
      sentAt: reviewInvites.sentAt,
      usedAt: reviewInvites.usedAt,
    })
    .from(reviewInvites)
    .where(eq(reviewInvites.token, token))
    .limit(1);
  if (!invite || invite.sentTo === null) return { outcome: "unknown-token" };

  // The (listing, email) pair is unique, which is what makes the invite — which
  // carries no review id of its own — resolve to exactly one review.
  const [review] = await tx
    .select({
      id: reviews.id,
      title: reviews.title,
      body: reviews.body,
      displayName: reviews.authorDisplayName,
      status: reviews.status,
      flaggedReason: reviews.flaggedReason,
    })
    .from(reviews)
    .where(and(eq(reviews.listingId, invite.listingId), eq(reviews.authorEmail, invite.sentTo)))
    .limit(1);
  if (!review) return { outcome: "unknown-token" };

  const [place] = await tx
    .select({ listingSlug: listings.slug, citySlug: cities.slug })
    .from(listings)
    .innerJoin(cities, eq(cities.id, listings.cityId))
    .where(eq(listings.id, invite.listingId))
    .limit(1);
  if (!place) return { outcome: "unknown-token" };
  const path = `/${place.citySlug}/${place.listingSlug}`;

  if (invite.usedAt !== null) {
    return {
      outcome: "verified",
      reviewId: review.id,
      listingId: invite.listingId,
      path,
      // A moderator may have published or rejected it since; report the row.
      status: review.status === "published" ? "published" : "pending",
      flaggedReason: review.flaggedReason,
      repeat: true,
    };
  }

  // After the repeat branch, never before it: somebody who confirmed in time
  // and opens their own link again a month later should be told their review
  // is up, not that they missed a deadline.
  if (isInviteExpired(invite.sentAt)) {
    return { outcome: "expired", reviewId: review.id, listingId: invite.listingId, path };
  }

  const reason = flagReview({
    title: review.title,
    body: review.body,
    displayName: review.displayName,
  });
  const status = reason === null ? "published" : "pending";

  await tx
    .update(reviews)
    .set({ emailVerifiedAt: now(), status, flaggedReason: reason, updatedAt: now() })
    .where(eq(reviews.id, review.id));

  await tx
    .update(reviewInvites)
    .set({ usedAt: now(), updatedAt: now() })
    .where(eq(reviewInvites.id, invite.id));

  await recomputeListingRating(tx, invite.listingId);

  return {
    outcome: "verified",
    reviewId: review.id,
    listingId: invite.listingId,
    path,
    status,
    flaggedReason: reason,
    repeat: false,
  };
}

/* ------------------------------------------------ preview and re-send */

export type ReviewTokenPreview =
  | { outcome: "confirmable"; listingName: string; listingPath: string }
  | { outcome: "expired"; listingName: string; listingPath: string }
  | {
      outcome: "already-confirmed";
      listingName: string;
      listingPath: string;
      /** Published, or held for a moderator. The copy differs. */
      status: "published" | "pending";
    }
  | { outcome: "unknown" };

/** Everything the landing page needs, resolved from a token in one query. */
async function inviteContext(tx: TestDb, token: string) {
  if (token.trim() === "") return null;

  const [invite] = await tx
    .select({
      id: reviewInvites.id,
      listingId: reviewInvites.listingId,
      sentTo: reviewInvites.sentTo,
      sentAt: reviewInvites.sentAt,
      usedAt: reviewInvites.usedAt,
    })
    .from(reviewInvites)
    .where(eq(reviewInvites.token, token))
    .limit(1);
  if (!invite || invite.sentTo === null) return null;

  const [row] = await tx
    .select({
      reviewId: reviews.id,
      status: reviews.status,
      emailVerifiedAt: reviews.emailVerifiedAt,
      listingName: listings.name,
      listingSlug: listings.slug,
      citySlug: cities.slug,
    })
    .from(reviews)
    .innerJoin(listings, eq(listings.id, reviews.listingId))
    .innerJoin(cities, eq(cities.id, listings.cityId))
    .where(and(eq(reviews.listingId, invite.listingId), eq(reviews.authorEmail, invite.sentTo)))
    .limit(1);
  if (!row) return null;

  return { invite, review: row, path: `/${row.citySlug}/${row.listingSlug}` };
}

/**
 * What the verification link's landing page shows, WITHOUT confirming anything.
 *
 * The link travels through a mailbox, and a mailbox is full of things that
 * fetch every URL they see: security scanners that follow every link in a
 * message, corporate gateways that rewrite and pre-fetch them, chat link
 * previewers wherever the mail gets forwarded, the browser's own prefetcher.
 * While the GET published the review, any one of them could put a rating on a
 * business's page before a person had read the email — and "if you did not
 * write this, ignore it and nothing will be published" was not true.
 *
 * So the token buys a sentence and a button, and the POST behind the button is
 * what publishes. This function only reads.
 */
export async function previewReviewToken(
  tx: TestDb,
  _viewer: Viewer,
  token: string,
): Promise<ReviewTokenPreview> {
  const ctx = await inviteContext(tx, token);
  if (!ctx) return { outcome: "unknown" };

  const listingName = ctx.review.listingName;
  const listingPath = ctx.path;

  if (ctx.invite.usedAt !== null) {
    return {
      outcome: "already-confirmed",
      listingName,
      listingPath,
      status: ctx.review.status === "published" ? "published" : "pending",
    };
  }
  if (isInviteExpired(ctx.invite.sentAt)) return { outcome: "expired", listingName, listingPath };
  return { outcome: "confirmable", listingName, listingPath };
}

export type ResendReviewResult =
  | { outcome: "sent"; reviewId: string; listingId: string; token: string; path: string }
  | { outcome: "not-resendable" };

/**
 * A fresh link for a review whose link went stale.
 *
 * Without this the TTL would simply lose people: somebody writes a review,
 * comes back to the email a fortnight later and is told the link is dead, with
 * no way forward that does not involve writing the whole thing again (and the
 * one-per-listing index refuses that anyway). The expired link is the
 * credential — it proves the same mailbox — so nothing here takes an address
 * as input and no address is ever echoed back to the page.
 *
 * The invite row is REWRITTEN rather than added to: exactly one link per review
 * is live at any moment, so a resend genuinely retires the previous one instead
 * of leaving a second working key behind.
 *
 * Only for a review still waiting on its first confirmation. Once
 * `email_verified_at` is set the address is proved and re-sending would be a
 * way to mail an arbitrary address on demand.
 */
export async function resendReviewVerification(
  tx: TestDb,
  _viewer: Viewer,
  token: string,
): Promise<ResendReviewResult> {
  const ctx = await inviteContext(tx, token);
  if (!ctx) return { outcome: "not-resendable" };
  if (ctx.review.emailVerifiedAt !== null) return { outcome: "not-resendable" };
  if (ctx.review.status !== "pending") return { outcome: "not-resendable" };

  const fresh = mintToken();
  await tx
    .update(reviewInvites)
    .set({ token: fresh, sentAt: now(), usedAt: null, updatedAt: now() })
    .where(eq(reviewInvites.id, ctx.invite.id));

  return {
    outcome: "sent",
    reviewId: ctx.review.reviewId,
    listingId: ctx.invite.listingId,
    token: fresh,
    path: ctx.path,
  };
}

/* --------------------------------------------------------------- moderation */

export type ModerateReviewResult =
  | { outcome: "updated"; listingId: string }
  | { outcome: "unknown-review" };

/**
 * The admin queue's one write. Exported for the moderation page.
 *
 * Admin-only and audited in the caller's transaction: publishing or pulling a
 * review changes a business's public rating, which is the most contestable
 * thing this site does.
 */
export async function moderateReview(
  tx: TestDb,
  viewer: Viewer,
  reviewId: string,
  input: { status: "published" | "rejected" | "pending" | "disputed"; note?: string },
): Promise<ModerateReviewResult> {
  if (!isAdmin(viewer)) throw new Error("FORBIDDEN");
  if (!UUID.test(reviewId)) return { outcome: "unknown-review" };

  const [review] = await tx
    .select({ id: reviews.id, listingId: reviews.listingId, status: reviews.status })
    .from(reviews)
    .where(eq(reviews.id, reviewId))
    .limit(1);
  if (!review) return { outcome: "unknown-review" };

  await tx
    .update(reviews)
    .set({ status: input.status, updatedAt: now() })
    .where(eq(reviews.id, reviewId));

  const actorId = await profileIdOf(tx, viewer);
  await tx.insert(auditLog).values({
    actorId,
    action: "review.moderate",
    entityType: "review",
    entityId: reviewId,
    meta: { from: review.status, to: input.status, note: input.note ?? null },
    createdAt: now(),
    updatedAt: now(),
  });

  await recomputeListingRating(tx, review.listingId);
  return { outcome: "updated", listingId: review.listingId };
}

/* ------------------------------------------------------------------- replies */

export type CreateReplyResult =
  | { outcome: "created"; replyId: string; listingPath: string }
  | { outcome: "not-owner" }
  | { outcome: "already-replied" }
  | { outcome: "unknown-review" };

/**
 * One reply per review, and only from the listing's owner.
 *
 * The ownership test is done HERE against `listings.owner_id`, never by the
 * page: a reply is published copy attributed to the business, so the only
 * thing that may create one is proof of the account that owns the listing.
 */
export async function createReviewReply(
  tx: TestDb,
  viewer: Viewer,
  input: { reviewId: string; body: string },
): Promise<CreateReplyResult> {
  const profileId = await profileIdOf(tx, viewer);
  if (profileId === null) return { outcome: "not-owner" };
  if (!UUID.test(input.reviewId)) return { outcome: "unknown-review" };

  const [review] = await tx
    .select({
      id: reviews.id,
      listingId: reviews.listingId,
      ownerId: listings.ownerId,
      listingSlug: listings.slug,
      citySlug: cities.slug,
    })
    .from(reviews)
    .innerJoin(listings, eq(listings.id, reviews.listingId))
    .innerJoin(cities, eq(cities.id, listings.cityId))
    .where(and(eq(reviews.id, input.reviewId), eq(reviews.status, "published")))
    .limit(1);
  if (!review) return { outcome: "unknown-review" };
  if (review.ownerId !== profileId) return { outcome: "not-owner" };

  const inserted = await tx
    .insert(reviewReplies)
    .values({
      reviewId: review.id,
      listingId: review.listingId,
      authorId: profileId,
      body: input.body,
      // An owner's reply is signed-in, attributable copy from the business
      // being reviewed. Holding it in a queue would mean a business cannot
      // answer a bad review for a day, which is the whole point of a reply.
      status: "published",
      createdAt: now(),
      updatedAt: now(),
    })
    .onConflictDoNothing({ target: reviewReplies.reviewId })
    .returning({ id: reviewReplies.id });

  const row = inserted[0];
  if (!row) return { outcome: "already-replied" };

  await tx.insert(auditLog).values({
    actorId: profileId,
    action: "review.reply",
    entityType: "review",
    entityId: review.id,
    meta: { listingId: review.listingId, replyId: row.id },
    createdAt: now(),
    updatedAt: now(),
  });

  return {
    outcome: "created",
    replyId: row.id,
    listingPath: `/${review.citySlug}/${review.listingSlug}`,
  };
}

/* --------------------------------------------------------------------- read */

function publishedFor(listingId: string) {
  return and(eq(reviews.listingId, listingId), eq(reviews.status, "published"))!;
}

export async function listPublishedReviews(
  tx: TestDb,
  _viewer: Viewer,
  listingId: string,
  opts: { page?: number; perPage?: number } = {},
): Promise<PublicReview[]> {
  if (!UUID.test(listingId)) return [];
  const page = Math.max(1, Math.trunc(opts.page ?? 1));
  const perPage = opts.perPage ?? REVIEWS_PER_PAGE;

  const rows = await tx
    .select({
      ...publicReviewColumns,
      reply: reviewReplies.body,
      replyStatus: reviewReplies.status,
      repliedAt: reviewReplies.createdAt,
    })
    .from(reviews)
    .leftJoin(reviewReplies, eq(reviewReplies.reviewId, reviews.id))
    .where(publishedFor(listingId))
    // `created_at` alone is not a total order — rows written in one
    // transaction can share it — and an unstable order across pages drops
    // reviews out of the middle of a paginated set.
    .orderBy(desc(reviews.createdAt), desc(reviews.id))
    .limit(perPage)
    .offset((page - 1) * perPage);

  return rows.map((r) => ({
    id: r.id,
    createdAt: r.createdAt,
    rating: r.rating,
    subRatings: r.subRatings,
    title: r.title,
    body: r.body,
    displayName: r.displayName,
    reply: r.replyStatus === "published" ? r.reply : null,
    repliedAt: r.replyStatus === "published" ? r.repliedAt : null,
  }));
}

export async function countPublishedReviews(
  tx: TestDb,
  _viewer: Viewer,
  listingId: string,
): Promise<number> {
  if (!UUID.test(listingId)) return 0;
  const [row] = await tx.select({ n: count() }).from(reviews).where(publishedFor(listingId));
  return row?.n ?? 0;
}

export interface ReviewSummary {
  /** Null when there are none. NEVER 0 — a zero would render as no stars. */
  average: number | null;
  count: number;
  recent: PublicReview[];
}

/**
 * What the listing page shows: the stored aggregate plus the first few
 * reviews, so the number on the page and the reviews under it come from the
 * same place and cannot disagree.
 */
export async function reviewSummary(
  tx: TestDb,
  viewer: Viewer,
  listingId: string,
  limit = SUMMARY_REVIEWS,
): Promise<ReviewSummary> {
  const [row] = await tx
    .select({ ratingAvg: listings.ratingAvg, ratingCount: listings.ratingCount })
    .from(listings)
    .where(eq(listings.id, listingId))
    .limit(1);

  const total = row?.ratingCount ?? 0;
  if (total === 0 || row?.ratingAvg === null || row?.ratingAvg === undefined) {
    return { average: null, count: 0, recent: [] };
  }

  const recent = await listPublishedReviews(tx, viewer, listingId, { page: 1, perPage: limit });
  return { average: Number(row.ratingAvg), count: total, recent };
}

/**
 * The listing the review form is about.
 *
 * Published-only and projected to the three fields the form renders, so the
 * page that collects a review can never quietly expose a pending listing or
 * ship a description into the RSC payload of a form.
 */
export async function reviewTarget(
  tx: TestDb,
  viewer: Viewer,
  listingId: string,
): Promise<{ id: string; name: string; path: string } | null> {
  if (!UUID.test(listingId)) return null;
  const [row] = await tx
    .select({ id: listings.id, name: listings.name, slug: listings.slug, citySlug: cities.slug })
    .from(listings)
    .innerJoin(cities, eq(cities.id, listings.cityId))
    .where(and(eq(listings.id, listingId), publishedListings(viewer)))
    .limit(1);
  if (!row) return null;
  return { id: row.id, name: row.name, path: `/${row.citySlug}/${row.slug}` };
}

/* ------------------------------------------------------------ notifications */

export interface ReviewNotification {
  reviewId: string;
  authorEmail: string;
  authorDisplayName: string | null;
  rating: number;
  title: string | null;
  body: string | null;
  status: "pending" | "published" | "rejected" | "disputed";
  flaggedReason: string | null;
  /** Null once the link has been used; the worker has nothing to send then. */
  token: string | null;
  listing: { id: string; name: string; email: string | null; claimed: boolean; path: string };
}

/**
 * The read model the notification worker sends from. Admin-only: it carries
 * the reviewer's address and the token that publishes their review.
 */
export async function reviewNotification(
  tx: TestDb,
  viewer: Viewer,
  reviewId: string,
): Promise<ReviewNotification | null> {
  if (!isAdmin(viewer)) throw new Error("FORBIDDEN");
  if (!UUID.test(reviewId)) return null;

  const [row] = await tx
    .select({
      id: reviews.id,
      authorEmail: reviews.authorEmail,
      authorDisplayName: reviews.authorDisplayName,
      rating: reviews.rating,
      title: reviews.title,
      body: reviews.body,
      status: reviews.status,
      flaggedReason: reviews.flaggedReason,
      listingId: listings.id,
      listingName: listings.name,
      listingEmail: listings.email,
      claimStatus: listings.claimStatus,
      listingSlug: listings.slug,
      citySlug: cities.slug,
    })
    .from(reviews)
    .innerJoin(listings, eq(listings.id, reviews.listingId))
    .innerJoin(cities, eq(cities.id, listings.cityId))
    .where(eq(reviews.id, reviewId))
    .limit(1);
  if (!row) return null;

  const [invite] = await tx
    .select({ token: reviewInvites.token, usedAt: reviewInvites.usedAt })
    .from(reviewInvites)
    .where(
      and(
        eq(reviewInvites.listingId, row.listingId),
        eq(reviewInvites.sentTo, row.authorEmail),
      ),
    )
    .orderBy(desc(reviewInvites.createdAt))
    .limit(1);

  return {
    reviewId: row.id,
    authorEmail: row.authorEmail,
    authorDisplayName: row.authorDisplayName,
    rating: row.rating,
    title: row.title,
    body: row.body,
    status: row.status,
    flaggedReason: row.flaggedReason,
    token: invite && invite.usedAt === null ? invite.token : null,
    listing: {
      id: row.listingId,
      name: row.listingName,
      email: row.listingEmail,
      claimed: row.claimStatus !== "unclaimed",
      path: `/${row.citySlug}/${row.listingSlug}`,
    },
  };
}
