import { describe, it, expect, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { withTestDb, type TestDb } from "@/test/db";
import { makeScaffold, makeListing } from "@/test/factories";
import { auditLog, listings, profiles, reviews, reviewInvites, user } from "@/lib/db/schema";
import { PUBLIC_VIEWER, type Viewer } from "@/lib/db/viewer";
import { setClock, resetClock } from "@/lib/clock";
import {
  createReview,
  verifyReviewToken,
  moderateReview,
  recomputeListingRating,
  listPublishedReviews,
  countPublishedReviews,
  reviewSummary,
  createReviewReply,
  reviewNotification,
  previewReviewToken,
  resendReviewVerification,
  REVIEWS_PER_PAGE,
  REVIEW_TOKEN_TTL_DAYS,
} from "./reviews";

const GOOD_BODY =
  "Booked through here and the whole thing went smoothly from the first reply to the final invoice. Would use them again without hesitating.";

function input(listingId: string, patch: Record<string, unknown> = {}) {
  return {
    listingId,
    rating: 5,
    subRatings: null,
    title: "Did exactly what they said",
    body: GOOD_BODY,
    displayName: "Sam P",
    email: `sam-${randomUUID()}@example.test`,
    ip: "203.0.113.5",
    ...patch,
  };
}

async function makeOwner(tx: TestDb): Promise<{ viewer: Viewer; profileId: string }> {
  const userId = `u_${randomUUID()}`;
  await tx.insert(user).values({
    id: userId, name: "Owner", email: `${userId}@example.test`, emailVerified: true,
  });
  const [profile] = await tx.insert(profiles).values({ userId }).returning({ id: profiles.id });
  return { viewer: { role: "owner", userId }, profileId: profile!.id };
}

async function adminViewer(tx: TestDb): Promise<Viewer> {
  const userId = `u_${randomUUID()}`;
  await tx.insert(user).values({
    id: userId, name: "Admin", email: `${userId}@example.test`, emailVerified: true,
  });
  await tx.insert(profiles).values({ userId, role: "admin" });
  return { role: "admin", userId };
}

/** Submit + click the link, which is what every other test needs to set up. */
async function published(tx: TestDb, listingId: string, patch: Record<string, unknown> = {}) {
  const created = await createReview(tx, PUBLIC_VIEWER, input(listingId, patch));
  if (created.outcome !== "created") throw new Error(`expected created, got ${created.outcome}`);
  const verified = await verifyReviewToken(tx, PUBLIC_VIEWER, created.token);
  return { created, verified };
}

describe("createReview", () => {
  it("writes a pending review and a single-use token", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const listingId = await makeListing(tx, ctx, { name: "The Old Barn" });

      const result = await createReview(tx, PUBLIC_VIEWER, input(listingId));
      expect(result.outcome).toBe("created");
      if (result.outcome !== "created") return;

      const [row] = await tx.select().from(reviews).where(eq(reviews.id, result.reviewId));
      expect(row!.status).toBe("pending");
      expect(row!.emailVerifiedAt).toBeNull();

      const [invite] = await tx
        .select().from(reviewInvites).where(eq(reviewInvites.token, result.token));
      expect(invite!.listingId).toBe(listingId);
      expect(invite!.usedAt).toBeNull();
    });
  });

  it("never moves the listing's rating before the review is published", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const listingId = await makeListing(tx, ctx, { name: "The Old Barn" });
      await createReview(tx, PUBLIC_VIEWER, input(listingId));

      const [listing] = await tx.select().from(listings).where(eq(listings.id, listingId));
      expect(listing!.ratingCount).toBe(0);
      expect(listing!.ratingAvg).toBeNull();
    });
  });

  it("refuses a listing that is not published", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const listingId = await makeListing(tx, ctx, { name: "Draft", status: "pending" });
      expect((await createReview(tx, PUBLIC_VIEWER, input(listingId))).outcome)
        .toBe("unknown-listing");
    });
  });

  it("refuses a listing id that does not exist", async () => {
    await withTestDb(async (tx) => {
      expect((await createReview(tx, PUBLIC_VIEWER, input(randomUUID()))).outcome)
        .toBe("unknown-listing");
    });
  });

  it("allows one review per email per listing", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const listingId = await makeListing(tx, ctx, { name: "The Old Barn" });
      const email = "same@example.test";
      expect((await createReview(tx, PUBLIC_VIEWER, input(listingId, { email }))).outcome)
        .toBe("created");
      expect((await createReview(tx, PUBLIC_VIEWER, input(listingId, { email }))).outcome)
        .toBe("already-reviewed");
    });
  });

  it("lets the same person review a different listing", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const a = await makeListing(tx, ctx, { name: "One" });
      const b = await makeListing(tx, ctx, { name: "Two" });
      const email = "same@example.test";
      expect((await createReview(tx, PUBLIC_VIEWER, input(a, { email }))).outcome).toBe("created");
      expect((await createReview(tx, PUBLIC_VIEWER, input(b, { email }))).outcome).toBe("created");
    });
  });

  it("refuses the owner of the listing, signed in", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const { viewer, profileId } = await makeOwner(tx);
      const listingId = await makeListing(tx, ctx, { name: "Mine", ownerId: profileId });
      expect((await createReview(tx, viewer, input(listingId))).outcome).toBe("own-listing");
    });
  });

  it("lets a signed-in visitor review somebody else's listing", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const { profileId } = await makeOwner(tx);
      const other = await makeOwner(tx);
      const listingId = await makeListing(tx, ctx, { name: "Theirs", ownerId: profileId });
      expect((await createReview(tx, other.viewer, input(listingId))).outcome).toBe("created");
    });
  });

  it("refuses a review sent from the listing's own contact address", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const listingId = await makeListing(tx, ctx, { name: "Mine", email: "Hello@Barn.example" });
      expect((await createReview(tx, PUBLIC_VIEWER, input(listingId, { email: "hello@barn.example" })))
        .outcome).toBe("own-listing");
    });
  });
});

describe("verifyReviewToken", () => {
  it("publishes a clean review and moves the aggregate", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const listingId = await makeListing(tx, ctx, { name: "The Old Barn" });
      const { verified } = await published(tx, listingId, { rating: 4 });

      expect(verified.outcome).toBe("verified");
      if (verified.outcome !== "verified") return;
      expect(verified.status).toBe("published");
      expect(verified.flaggedReason).toBeNull();
      expect(verified.path).toMatch(/^\/[a-z0-9-]+\/[a-z0-9-]+$/);

      const [row] = await tx.select().from(reviews).where(eq(reviews.id, verified.reviewId));
      expect(row!.status).toBe("published");
      expect(row!.emailVerifiedAt).not.toBeNull();

      const [listing] = await tx.select().from(listings).where(eq(listings.id, listingId));
      expect(listing!.ratingCount).toBe(1);
      expect(Number(listing!.ratingAvg)).toBe(4);
    });
  });

  it("holds a flagged review as pending and leaves the aggregate alone", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const listingId = await makeListing(tx, ctx, { name: "The Old Barn" });
      const { verified } = await published(tx, listingId, {
        body: `${GOOD_BODY} Book direct at https://example.com/cheaper`,
      });

      expect(verified.outcome).toBe("verified");
      if (verified.outcome !== "verified") return;
      expect(verified.status).toBe("pending");
      expect(verified.flaggedReason).toBe("link");

      const [row] = await tx.select().from(reviews).where(eq(reviews.id, verified.reviewId));
      expect(row!.status).toBe("pending");
      // The email was still proved — that is what the click was for.
      expect(row!.emailVerifiedAt).not.toBeNull();
      expect(row!.flaggedReason).toBe("link");

      const [listing] = await tx.select().from(listings).where(eq(listings.id, listingId));
      expect(listing!.ratingCount).toBe(0);
    });
  });

  it("burns the token", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const listingId = await makeListing(tx, ctx, { name: "The Old Barn" });
      const { created } = await published(tx, listingId);
      if (created.outcome !== "created") return;

      const [invite] = await tx
        .select().from(reviewInvites).where(eq(reviewInvites.token, created.token));
      expect(invite!.usedAt).not.toBeNull();
    });
  });

  it("treats a second click as a repeat rather than a dead link", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const listingId = await makeListing(tx, ctx, { name: "The Old Barn" });
      const { created } = await published(tx, listingId);
      if (created.outcome !== "created") return;

      const again = await verifyReviewToken(tx, PUBLIC_VIEWER, created.token);
      expect(again.outcome).toBe("verified");
      if (again.outcome !== "verified") return;
      expect(again.repeat).toBe(true);
      expect(again.status).toBe("published");

      // And it did not double-count.
      const [listing] = await tx.select().from(listings).where(eq(listings.id, listingId));
      expect(listing!.ratingCount).toBe(1);
    });
  });

  it("rejects a token nobody issued", async () => {
    await withTestDb(async (tx) => {
      expect((await verifyReviewToken(tx, PUBLIC_VIEWER, "not-a-token")).outcome)
        .toBe("unknown-token");
      expect((await verifyReviewToken(tx, PUBLIC_VIEWER, "")).outcome).toBe("unknown-token");
    });
  });

  describe("expiry", () => {
    afterEach(() => { resetClock(); });

    const SENT = new Date("2026-09-01T09:00:00Z");
    const day = (n: number) => new Date(SENT.getTime() + n * 86_400_000);

    async function invited(tx: TestDb) {
      const ctx = await makeScaffold(tx);
      const listingId = await makeListing(tx, ctx, { name: "The Old Barn" });
      setClock(SENT);
      const created = await createReview(tx, PUBLIC_VIEWER, input(listingId));
      if (created.outcome !== "created") throw new Error(created.outcome);
      return { listingId, token: created.token, reviewId: created.reviewId };
    }

    it("still verifies inside the window", async () => {
      await withTestDb(async (tx) => {
        const { token } = await invited(tx);
        setClock(day(REVIEW_TOKEN_TTL_DAYS - 1));
        expect((await verifyReviewToken(tx, PUBLIC_VIEWER, token)).outcome).toBe("verified");
      });
    });

    it("expires after the TTL and publishes nothing", async () => {
      await withTestDb(async (tx) => {
        const { token, listingId, reviewId } = await invited(tx);
        setClock(day(REVIEW_TOKEN_TTL_DAYS + 1));

        const result = await verifyReviewToken(tx, PUBLIC_VIEWER, token);
        expect(result.outcome).toBe("expired");
        if (result.outcome !== "expired") return;
        expect(result.listingId).toBe(listingId);
        expect(result.path).toMatch(/^\/[a-z0-9-]+\/[a-z0-9-]+$/);

        const [row] = await tx.select().from(reviews).where(eq(reviews.id, reviewId));
        expect(row!.status).toBe("pending");
        expect(row!.emailVerifiedAt).toBeNull();
        const [listing] = await tx.select().from(listings).where(eq(listings.id, listingId));
        expect(listing!.ratingCount).toBe(0);
        // And the link is not burned — it stays expired rather than becoming a repeat.
        const [invite] = await tx
          .select().from(reviewInvites).where(eq(reviewInvites.token, token));
        expect(invite!.usedAt).toBeNull();
      });
    });

    it("an invite with no send date is treated as expired, not as valid forever", async () => {
      await withTestDb(async (tx) => {
        const { token } = await invited(tx);
        await tx.update(reviewInvites).set({ sentAt: null })
          .where(eq(reviewInvites.token, token));
        expect((await verifyReviewToken(tx, PUBLIC_VIEWER, token)).outcome).toBe("expired");
      });
    });

    it("an already-used link stays a repeat however old it is", async () => {
      await withTestDb(async (tx) => {
        const { token } = await invited(tx);
        await verifyReviewToken(tx, PUBLIC_VIEWER, token);
        setClock(day(REVIEW_TOKEN_TTL_DAYS + 30));

        const again = await verifyReviewToken(tx, PUBLIC_VIEWER, token);
        expect(again.outcome).toBe("verified");
        if (again.outcome !== "verified") return;
        expect(again.repeat).toBe(true);
      });
    });
  });
});

describe("previewReviewToken", () => {
  afterEach(() => { resetClock(); });

  async function invited(tx: TestDb) {
    const ctx = await makeScaffold(tx);
    const listingId = await makeListing(tx, ctx, { name: "The Old Barn" });
    setClock(new Date("2026-09-01T09:00:00Z"));
    const created = await createReview(tx, PUBLIC_VIEWER, input(listingId));
    if (created.outcome !== "created") throw new Error(created.outcome);
    return { listingId, token: created.token, reviewId: created.reviewId };
  }

  it("names the listing and confirms nothing", async () => {
    await withTestDb(async (tx) => {
      const { token, listingId, reviewId } = await invited(tx);
      const preview = await previewReviewToken(tx, PUBLIC_VIEWER, token);

      expect(preview.outcome).toBe("confirmable");
      if (preview.outcome !== "confirmable") return;
      expect(preview.listingName).toBe("The Old Barn");
      expect(preview.listingPath).toMatch(/^\/[a-z0-9-]+\/[a-z0-9-]+$/);

      // The whole point of finding 2: a link scanner opening this publishes nothing.
      const [row] = await tx.select().from(reviews).where(eq(reviews.id, reviewId));
      expect(row!.status).toBe("pending");
      expect(row!.emailVerifiedAt).toBeNull();
      const [invite] = await tx
        .select().from(reviewInvites).where(eq(reviewInvites.token, token));
      expect(invite!.usedAt).toBeNull();
      const [listing] = await tx.select().from(listings).where(eq(listings.id, listingId));
      expect(listing!.ratingCount).toBe(0);
    });
  });

  it("tells expired, already-confirmed and unknown apart", async () => {
    await withTestDb(async (tx) => {
      const { token } = await invited(tx);
      setClock(new Date("2026-09-20T09:00:00Z"));
      expect((await previewReviewToken(tx, PUBLIC_VIEWER, token)).outcome).toBe("expired");
      expect((await previewReviewToken(tx, PUBLIC_VIEWER, "made-up")).outcome).toBe("unknown");
      expect((await previewReviewToken(tx, PUBLIC_VIEWER, "")).outcome).toBe("unknown");
    });
  });

  it("reports a spent link as already-confirmed, with somewhere to go", async () => {
    await withTestDb(async (tx) => {
      const { token } = await invited(tx);
      await verifyReviewToken(tx, PUBLIC_VIEWER, token);

      const preview = await previewReviewToken(tx, PUBLIC_VIEWER, token);
      expect(preview.outcome).toBe("already-confirmed");
      if (preview.outcome !== "already-confirmed") return;
      expect(preview.status).toBe("published");
      expect(preview.listingPath).toMatch(/^\/[a-z0-9-]+\/[a-z0-9-]+$/);
    });
  });
});

describe("resendReviewVerification", () => {
  afterEach(() => { resetClock(); });

  const SENT = new Date("2026-09-01T09:00:00Z");

  async function stale(tx: TestDb) {
    const ctx = await makeScaffold(tx);
    const listingId = await makeListing(tx, ctx, { name: "The Old Barn" });
    setClock(SENT);
    const created = await createReview(tx, PUBLIC_VIEWER, input(listingId));
    if (created.outcome !== "created") throw new Error(created.outcome);
    setClock(new Date(SENT.getTime() + (REVIEW_TOKEN_TTL_DAYS + 2) * 86_400_000));
    return { listingId, token: created.token, reviewId: created.reviewId };
  }

  it("mints a fresh token that works, and kills the old one", async () => {
    await withTestDb(async (tx) => {
      const { token, reviewId } = await stale(tx);

      const result = await resendReviewVerification(tx, PUBLIC_VIEWER, token);
      expect(result.outcome).toBe("sent");
      if (result.outcome !== "sent") return;
      expect(result.reviewId).toBe(reviewId);
      expect(result.token).not.toBe(token);

      // The dead link is dead: it no longer resolves to anything at all.
      expect((await verifyReviewToken(tx, PUBLIC_VIEWER, token)).outcome).toBe("unknown-token");
      expect((await verifyReviewToken(tx, PUBLIC_VIEWER, result.token)).outcome).toBe("verified");
    });
  });

  it("refuses once the review has already been confirmed", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const listingId = await makeListing(tx, ctx, { name: "The Old Barn" });
      const { created } = await published(tx, listingId);
      if (created.outcome !== "created") return;

      expect((await resendReviewVerification(tx, PUBLIC_VIEWER, created.token)).outcome)
        .toBe("not-resendable");
    });
  });

  it("refuses a token nobody issued", async () => {
    await withTestDb(async (tx) => {
      expect((await resendReviewVerification(tx, PUBLIC_VIEWER, "made-up")).outcome)
        .toBe("not-resendable");
      expect((await resendReviewVerification(tx, PUBLIC_VIEWER, "")).outcome)
        .toBe("not-resendable");
    });
  });

  it("is usable while the first link is still live, and only one link is ever live", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const listingId = await makeListing(tx, ctx, { name: "The Old Barn" });
      setClock(SENT);
      const created = await createReview(tx, PUBLIC_VIEWER, input(listingId));
      if (created.outcome !== "created") return;

      const first = await resendReviewVerification(tx, PUBLIC_VIEWER, created.token);
      if (first.outcome !== "sent") throw new Error(first.outcome);
      const second = await resendReviewVerification(tx, PUBLIC_VIEWER, first.token);
      if (second.outcome !== "sent") throw new Error(second.outcome);

      const rows = await tx.select().from(reviewInvites)
        .where(eq(reviewInvites.listingId, listingId));
      expect(rows, "the invite is rewritten in place, not stacked up").toHaveLength(1);
      expect(rows[0]!.token).toBe(second.token);
    });
  });
});

describe("recomputeListingRating", () => {
  it("averages the published reviews and nothing else", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const listingId = await makeListing(tx, ctx, { name: "The Old Barn" });

      await published(tx, listingId, { rating: 5, email: "a@example.test" });
      await published(tx, listingId, { rating: 4, email: "b@example.test" });
      // Pending: verified but flagged, so it must not count.
      await published(tx, listingId, {
        rating: 1, email: "c@example.test", body: "Bad.",
      });

      const [listing] = await tx.select().from(listings).where(eq(listings.id, listingId));
      expect(listing!.ratingCount).toBe(2);
      expect(Number(listing!.ratingAvg)).toBe(4.5);
    });
  });

  it("returns a listing with no published reviews to no rating at all", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const listingId = await makeListing(tx, ctx, { name: "The Old Barn" });
      const { verified } = await published(tx, listingId, { rating: 5 });
      if (verified.outcome !== "verified") return;

      await tx.update(reviews).set({ status: "rejected" }).where(eq(reviews.id, verified.reviewId));
      await recomputeListingRating(tx, listingId);

      const [listing] = await tx.select().from(listings).where(eq(listings.id, listingId));
      expect(listing!.ratingCount).toBe(0);
      expect(listing!.ratingAvg).toBeNull();
    });
  });

  it("rounds to one decimal place, which is what the column holds", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const listingId = await makeListing(tx, ctx, { name: "The Old Barn" });
      await published(tx, listingId, { rating: 5, email: "a@example.test" });
      await published(tx, listingId, { rating: 4, email: "b@example.test" });
      await published(tx, listingId, { rating: 4, email: "c@example.test" });

      const [listing] = await tx.select().from(listings).where(eq(listings.id, listingId));
      expect(Number(listing!.ratingAvg)).toBeCloseTo(4.3, 5);
    });
  });
});

describe("moderateReview", () => {
  it("lets an admin publish a held review and recomputes the aggregate", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const listingId = await makeListing(tx, ctx, { name: "The Old Barn" });
      const { verified } = await published(tx, listingId, { rating: 3, body: "Fine." });
      if (verified.outcome !== "verified") return;
      const admin = await adminViewer(tx);

      const result = await moderateReview(tx, admin, verified.reviewId, { status: "published" });
      expect(result.outcome).toBe("updated");

      const [listing] = await tx.select().from(listings).where(eq(listings.id, listingId));
      expect(listing!.ratingCount).toBe(1);
      expect(Number(listing!.ratingAvg)).toBe(3);
    });
  });

  it("writes an audit_log row in the same transaction", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const listingId = await makeListing(tx, ctx, { name: "The Old Barn" });
      const { verified } = await published(tx, listingId, { body: "Fine." });
      if (verified.outcome !== "verified") return;
      const admin = await adminViewer(tx);

      await moderateReview(tx, admin, verified.reviewId, { status: "rejected" });
      const rows = await tx
        .select().from(auditLog).where(eq(auditLog.entityId, verified.reviewId));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.entityType).toBe("review");
      expect(rows[0]!.actorId).not.toBeNull();
    });
  });

  it("refuses anyone who is not an admin", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const listingId = await makeListing(tx, ctx, { name: "The Old Barn" });
      const { verified } = await published(tx, listingId);
      if (verified.outcome !== "verified") return;
      const owner = await makeOwner(tx);

      await expect(moderateReview(tx, owner.viewer, verified.reviewId, { status: "rejected" }))
        .rejects.toThrow(/FORBIDDEN/);
      await expect(moderateReview(tx, PUBLIC_VIEWER, verified.reviewId, { status: "rejected" }))
        .rejects.toThrow(/FORBIDDEN/);
    });
  });

  it("un-publishing drops the review out of the aggregate", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const listingId = await makeListing(tx, ctx, { name: "The Old Barn" });
      const { verified } = await published(tx, listingId, { rating: 5 });
      if (verified.outcome !== "verified") return;
      const admin = await adminViewer(tx);

      await moderateReview(tx, admin, verified.reviewId, { status: "rejected" });
      const [listing] = await tx.select().from(listings).where(eq(listings.id, listingId));
      expect(listing!.ratingCount).toBe(0);
      expect(listing!.ratingAvg).toBeNull();
    });
  });
});

describe("reading reviews", () => {
  afterEach(() => { resetClock(); });

  it("shows published reviews only, newest first", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const listingId = await makeListing(tx, ctx, { name: "The Old Barn" });
      // `created_at` defaults to the TRANSACTION timestamp, which is the same
      // instant for every row this test writes. The clock is what orders them,
      // and the review row is written with it rather than with defaultNow().
      setClock(new Date("2026-03-01T10:00:00Z"));
      await published(tx, listingId, { rating: 5, email: "a@example.test", title: "First" });
      setClock(new Date("2026-03-02T10:00:00Z"));
      await published(tx, listingId, { rating: 2, email: "b@example.test", title: "Second" });
      setClock(new Date("2026-03-03T10:00:00Z"));
      await published(tx, listingId, { email: "c@example.test", title: "Held", body: "No." });

      const rows = await listPublishedReviews(tx, PUBLIC_VIEWER, listingId, { page: 1 });
      expect(rows.map((r) => r.title)).toEqual(["Second", "First"]);
      expect(await countPublishedReviews(tx, PUBLIC_VIEWER, listingId)).toBe(2);
    });
  });

  it("never exposes the reviewer's email address or IP", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const listingId = await makeListing(tx, ctx, { name: "The Old Barn" });
      await published(tx, listingId, { email: "private@example.test" });

      const rows = await listPublishedReviews(tx, PUBLIC_VIEWER, listingId, { page: 1 });
      expect(JSON.stringify(rows)).not.toContain("private@example.test");
      expect(JSON.stringify(rows)).not.toContain("203.0.113.5");
      expect(rows[0]).not.toHaveProperty("authorEmail");
      expect(rows[0]).not.toHaveProperty("ip");
    });
  });

  it("paginates", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const listingId = await makeListing(tx, ctx, { name: "The Old Barn" });
      for (let n = 0; n < REVIEWS_PER_PAGE + 2; n++) {
        await published(tx, listingId, { email: `p${n}@example.test`, title: `R${n}` });
      }
      expect(await countPublishedReviews(tx, PUBLIC_VIEWER, listingId))
        .toBe(REVIEWS_PER_PAGE + 2);
      expect(await listPublishedReviews(tx, PUBLIC_VIEWER, listingId, { page: 1 }))
        .toHaveLength(REVIEWS_PER_PAGE);
      expect(await listPublishedReviews(tx, PUBLIC_VIEWER, listingId, { page: 2 }))
        .toHaveLength(2);
    });
  });

  it("summarises for the listing page — average, count and the first few", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const listingId = await makeListing(tx, ctx, { name: "The Old Barn" });
      for (let n = 0; n < 5; n++) {
        await published(tx, listingId, { email: `s${n}@example.test`, rating: 4 });
      }
      const summary = await reviewSummary(tx, PUBLIC_VIEWER, listingId, 3);
      expect(summary.count).toBe(5);
      expect(summary.average).toBe(4);
      expect(summary.recent).toHaveLength(3);
    });
  });

  it("summarises a listing with no reviews as nothing, never as zero stars", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const listingId = await makeListing(tx, ctx, { name: "The Old Barn" });
      const summary = await reviewSummary(tx, PUBLIC_VIEWER, listingId, 3);
      expect(summary.count).toBe(0);
      expect(summary.average).toBeNull();
      expect(summary.recent).toEqual([]);
    });
  });
});

describe("createReviewReply", () => {
  it("lets the owner of the listing reply once", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const { viewer, profileId } = await makeOwner(tx);
      const listingId = await makeListing(tx, ctx, { name: "Mine", ownerId: profileId });
      const { verified } = await published(tx, listingId);
      if (verified.outcome !== "verified") return;

      const first = await createReviewReply(tx, viewer, {
        reviewId: verified.reviewId,
        body: "Thanks for taking the time — glad it went well.",
      });
      expect(first.outcome).toBe("created");

      const second = await createReviewReply(tx, viewer, {
        reviewId: verified.reviewId, body: "And again.",
      });
      expect(second.outcome).toBe("already-replied");
    });
  });

  it("refuses somebody who does not own the listing", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const { profileId } = await makeOwner(tx);
      const stranger = await makeOwner(tx);
      const listingId = await makeListing(tx, ctx, { name: "Theirs", ownerId: profileId });
      const { verified } = await published(tx, listingId);
      if (verified.outcome !== "verified") return;

      expect((await createReviewReply(tx, stranger.viewer, {
        reviewId: verified.reviewId, body: "Not mine but here I am.",
      })).outcome).toBe("not-owner");

      expect((await createReviewReply(tx, PUBLIC_VIEWER, {
        reviewId: verified.reviewId, body: "Anonymous reply.",
      })).outcome).toBe("not-owner");
    });
  });

  it("refuses a reply to a review that is not published", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const { viewer, profileId } = await makeOwner(tx);
      const listingId = await makeListing(tx, ctx, { name: "Mine", ownerId: profileId });
      const { verified } = await published(tx, listingId, { body: "No." });
      if (verified.outcome !== "verified") return;

      expect((await createReviewReply(tx, viewer, {
        reviewId: verified.reviewId, body: "Replying to a held review.",
      })).outcome).toBe("unknown-review");
    });
  });

  it("writes an audit_log row for the owner's mutation", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const { viewer, profileId } = await makeOwner(tx);
      const listingId = await makeListing(tx, ctx, { name: "Mine", ownerId: profileId });
      const { verified } = await published(tx, listingId);
      if (verified.outcome !== "verified") return;

      await createReviewReply(tx, viewer, { reviewId: verified.reviewId, body: "Thank you." });
      const rows = await tx
        .select().from(auditLog)
        .where(and(eq(auditLog.entityId, verified.reviewId), eq(auditLog.action, "review.reply")));
      expect(rows).toHaveLength(1);
    });
  });

  it("renders the reply alongside the review it answers", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const { viewer, profileId } = await makeOwner(tx);
      const listingId = await makeListing(tx, ctx, { name: "Mine", ownerId: profileId });
      const { verified } = await published(tx, listingId);
      if (verified.outcome !== "verified") return;
      await createReviewReply(tx, viewer, { reviewId: verified.reviewId, body: "Thank you." });

      const rows = await listPublishedReviews(tx, PUBLIC_VIEWER, listingId, { page: 1 });
      expect(rows[0]!.reply).toBe("Thank you.");
    });
  });
});

describe("reviewNotification", () => {
  it("gives the worker the address, the token and the listing, admin only", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const listingId = await makeListing(tx, ctx, { name: "The Old Barn" });
      const created = await createReview(tx, PUBLIC_VIEWER, input(listingId, {
        email: "reviewer@example.test",
      }));
      if (created.outcome !== "created") throw new Error("not created");
      const admin = await adminViewer(tx);

      const data = await reviewNotification(tx, admin, created.reviewId);
      expect(data).not.toBeNull();
      expect(data!.authorEmail).toBe("reviewer@example.test");
      expect(data!.token).toBe(created.token);
      expect(data!.listing.name).toBe("The Old Barn");

      await expect(reviewNotification(tx, PUBLIC_VIEWER, created.reviewId))
        .rejects.toThrow(/FORBIDDEN/);
    });
  });
});
