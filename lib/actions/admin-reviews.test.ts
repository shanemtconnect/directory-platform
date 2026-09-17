import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ModerateReviewResult } from "@/lib/db/queries/reviews";
import type { SubmissionDetail } from "@/lib/db/queries/admin/submissions";
import type { Viewer } from "@/lib/db/viewer";

/**
 * The two writes behind /admin/reviews.
 *
 * Unit tests with the database mocked out: what a decision does to the rows —
 * the status, the audit row, the aggregate recompute — is `moderateReview` and
 * is tested against a real transaction in lib/db/queries/reviews.test.ts. What
 * is only testable HERE is the layer the queue calls: that it refuses a
 * non-admin before opening a transaction, that the moderator's IP reaches the
 * audit trail, that a second click on a decided row says so, and that a
 * decision busts every cached page the rating is printed on.
 */

const requireAdmin = vi.fn<() => Promise<Viewer>>();
const moderateReview = vi.fn<() => Promise<ModerateReviewResult>>();
const submissionDetail = vi.fn<() => Promise<SubmissionDetail | null>>();
const revalidatePath = vi.fn<(path: string) => void>();

const HANDLE = { marker: "the transaction" };
const transaction = vi.fn(
  async <T,>(fn: (tx: unknown) => Promise<T>): Promise<T> => await fn(HANDLE),
);

let requestHeaders = new Headers();

vi.mock("next/headers", () => ({ headers: () => Promise.resolve(requestHeaders) }));
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => revalidatePath(p) }));
vi.mock("@/lib/db/client", () => ({ db: { transaction: (fn: never) => transaction(fn) } }));
vi.mock("@/lib/auth/viewer", () => ({ requireAdmin: () => requireAdmin() }));
vi.mock("@/lib/db/queries/reviews", () => ({
  moderateReview: (...args: unknown[]) => moderateReview(...(args as [])),
}));
vi.mock("@/lib/db/queries/admin/submissions", () => ({
  submissionDetail: (...args: unknown[]) => submissionDetail(...(args as [])),
}));

const ADMIN: Viewer = { role: "admin", userId: "user_admin" };
const REVIEW_ID = "11111111-1111-4111-8111-111111111111";
const LISTING_ID = "33333333-3333-4333-8333-333333333333";

const DETAIL = {
  id: LISTING_ID,
  citySlug: "richmond",
  slug: "the-old-hall",
  categorySlug: "barns",
} as unknown as SubmissionDetail;

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
}

async function load() {
  return await import("./admin-reviews");
}

beforeEach(() => {
  vi.resetModules();
  requestHeaders = new Headers({ "x-forwarded-for": "203.0.113.9" });
  requireAdmin.mockReset().mockResolvedValue(ADMIN);
  moderateReview.mockReset().mockResolvedValue({ outcome: "updated", listingId: LISTING_ID });
  submissionDetail.mockReset().mockResolvedValue(DETAIL);
  revalidatePath.mockReset();
  transaction.mockClear();
});

describe("review moderation", () => {
  it("refuses a viewer who is not an admin before it opens a transaction", async () => {
    requireAdmin.mockRejectedValue(new Error("FORBIDDEN"));
    const { publishReviewAction } = await load();

    await expect(publishReviewAction({ status: "idle" }, form({ reviewId: REVIEW_ID })))
      .rejects.toThrow("FORBIDDEN");

    expect(transaction).not.toHaveBeenCalled();
    expect(moderateReview).not.toHaveBeenCalled();
  });

  it("publishes with the moderator's own IP on the record", async () => {
    const { publishReviewAction } = await load();

    const state = await publishReviewAction({ status: "idle" }, form({ reviewId: REVIEW_ID }));

    expect(moderateReview).toHaveBeenCalledWith(HANDLE, ADMIN, REVIEW_ID, {
      status: "published",
      ip: "203.0.113.9",
    });
    expect(state.status).toBe("done");
  });

  it("rejects rather than publishes when the reject button is used", async () => {
    const { rejectReviewAction } = await load();

    await rejectReviewAction({ status: "idle" }, form({ reviewId: REVIEW_ID }));

    expect(moderateReview).toHaveBeenCalledWith(HANDLE, ADMIN, REVIEW_ID, {
      status: "rejected",
      ip: "203.0.113.9",
    });
  });

  it("passes a null IP rather than a placeholder when no proxy header identifies the caller", async () => {
    requestHeaders = new Headers();
    const { rejectReviewAction } = await load();

    await rejectReviewAction({ status: "idle" }, form({ reviewId: REVIEW_ID }));

    expect(moderateReview).toHaveBeenCalledWith(HANDLE, ADMIN, REVIEW_ID, {
      status: "rejected",
      ip: null,
    });
  });

  it("does not open a transaction for an id that is not a uuid", async () => {
    const { publishReviewAction } = await load();

    const state = await publishReviewAction({ status: "idle" }, form({ reviewId: "nonsense" }));

    expect(transaction).not.toHaveBeenCalled();
    expect(state.status).toBe("error");
  });

  it("says so when the review is gone", async () => {
    moderateReview.mockResolvedValue({ outcome: "unknown-review" });
    const { publishReviewAction } = await load();

    const state = await publishReviewAction({ status: "idle" }, form({ reviewId: REVIEW_ID }));

    expect(state.status).toBe("error");
    expect(state.message).toMatch(/not there|gone/i);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("busts every cached page the rating is printed on, and the console pages", async () => {
    const { publishReviewAction } = await load();

    await publishReviewAction({ status: "idle" }, form({ reviewId: REVIEW_ID }));

    expect(submissionDetail).toHaveBeenCalledWith(HANDLE, ADMIN, LISTING_ID);
    expect(revalidatePath).toHaveBeenCalledWith("/richmond/the-old-hall");
    expect(revalidatePath).toHaveBeenCalledWith("/richmond/the-old-hall/reviews");
    expect(revalidatePath).toHaveBeenCalledWith("/richmond");
    expect(revalidatePath).toHaveBeenCalledWith("/richmond/barns");
    expect(revalidatePath).toHaveBeenCalledWith("/admin/reviews");
    expect(revalidatePath).toHaveBeenCalledWith("/admin");
  });

  it("a rejection busts the same pages — a held review that was published in the meantime comes down", async () => {
    const { rejectReviewAction } = await load();

    await rejectReviewAction({ status: "idle" }, form({ reviewId: REVIEW_ID }));

    expect(revalidatePath).toHaveBeenCalledWith("/richmond/the-old-hall/reviews");
    expect(revalidatePath).toHaveBeenCalledWith("/richmond");
  });

  it("still reports the decision when the listing's paths cannot be read", async () => {
    submissionDetail.mockResolvedValue(null);
    const { publishReviewAction } = await load();

    const state = await publishReviewAction({ status: "idle" }, form({ reviewId: REVIEW_ID }));

    expect(state.status).toBe("done");
    expect(revalidatePath).toHaveBeenCalledWith("/admin/reviews");
    expect(revalidatePath).not.toHaveBeenCalledWith("/richmond");
  });
});
