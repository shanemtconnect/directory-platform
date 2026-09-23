import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Viewer } from "@/lib/db/viewer";
import type { CreateReplyResult } from "@/lib/db/queries/reviews";
import type { RateLimitResult } from "@/lib/spam/rate-limit";

/**
 * The owner's reply, with the database mocked out.
 *
 * What the insert does is `createReviewReply` and is tested against a real
 * transaction in lib/db/queries/reviews.test.ts. What is only testable HERE
 * is what the action does with the answer: the reply lands on an ISR page,
 * and the action busts exactly the list the query reports through the one
 * revalidate helper, naming no path of its own.
 */

const currentViewer = vi.fn<() => Promise<Viewer>>();
const createReviewReply = vi.fn<(...a: unknown[]) => Promise<CreateReplyResult>>();
const limitPublicWrite = vi.fn<(...a: unknown[]) => Promise<RateLimitResult>>();
const revalidateListingPaths = vi.fn<(paths: readonly string[]) => void>();

const HANDLE = { marker: "the transaction" };
const transaction = vi.fn(
  async <T,>(fn: (tx: unknown) => Promise<T>): Promise<T> => await fn(HANDLE),
);

vi.mock("next/headers", () => ({
  headers: () => Promise.resolve(new Headers({ "x-forwarded-for": "203.0.113.9" })),
}));
vi.mock("@/lib/db/client", () => ({ db: { transaction: (fn: never) => transaction(fn) } }));
vi.mock("@/lib/features/flags", () => ({ isEnabled: () => true }));
vi.mock("@/lib/auth/viewer", () => ({ currentViewer: () => currentViewer() }));
vi.mock("@/lib/db/queries/reviews", () => ({
  createReview: vi.fn(),
  createReviewReply: (...args: unknown[]) => createReviewReply(...args),
  resendReviewVerification: vi.fn(),
}));
vi.mock("@/lib/email/notify", () => ({
  notifyReviewResent: vi.fn(),
  notifyReviewSubmitted: vi.fn(),
}));
vi.mock("@/lib/spam/write-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/spam/write-limit")>()),
  limitPublicWrite: (...args: unknown[]) => limitPublicWrite(...args),
}));
vi.mock("@/lib/revalidate/listing", () => ({
  revalidateListingPaths: (paths: readonly string[]) => revalidateListingPaths(paths),
}));

const OWNER: Viewer = { role: "owner", userId: "user_owner" };
const REVIEW_ID = "11111111-1111-4111-8111-111111111111";
const PATHS = ["/leeds/the-old-mill", "/leeds/the-old-mill/reviews", "/leeds", "/leeds/page/2", "/leeds/mills"];
const allowed: RateLimitResult = { allowed: true, remaining: 9, retryAfterSeconds: 0 };

function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

async function reply(fields: Record<string, string>) {
  const { replyToReview } = await import("./review");
  return replyToReview({ ok: false }, form(fields));
}

beforeEach(() => {
  vi.resetModules();
  currentViewer.mockReset().mockResolvedValue(OWNER);
  createReviewReply.mockReset();
  limitPublicWrite.mockReset().mockResolvedValue(allowed);
  revalidateListingPaths.mockReset();
  transaction.mockClear();
});

describe("replyToReview", () => {
  it("busts every page the query reports, through the one helper, once the transaction is back", async () => {
    createReviewReply.mockResolvedValue({ outcome: "created", replyId: "reply-1", paths: PATHS });

    const state = await reply({ reviewId: REVIEW_ID, body: "Thanks for taking the time — glad it went well." });

    expect(state).toEqual({ ok: true });
    expect(createReviewReply).toHaveBeenCalledWith(HANDLE, OWNER, {
      reviewId: REVIEW_ID,
      body: "Thanks for taking the time — glad it went well.",
    });
    expect(revalidateListingPaths).toHaveBeenCalledTimes(1);
    expect(revalidateListingPaths).toHaveBeenCalledWith(PATHS);
    // After the transaction has returned, never inside it: a path marked
    // stale before the commit can be re-cached with the old row.
    expect(transaction.mock.results[0]?.type).toBe("return");
  });

  it.each<CreateReplyResult>([
    { outcome: "not-owner" },
    { outcome: "already-replied" },
    { outcome: "unknown-review" },
  ])("busts nothing when the query refuses ($outcome)", async (result) => {
    createReviewReply.mockResolvedValue(result);

    const state = await reply({ reviewId: REVIEW_ID, body: "Long enough to pass validation." });

    expect(state.ok).toBe(false);
    expect(revalidateListingPaths).not.toHaveBeenCalled();
  });

  it("opens no transaction and busts nothing for a signed-out caller", async () => {
    currentViewer.mockResolvedValue({ role: "public" });

    const state = await reply({ reviewId: REVIEW_ID, body: "Long enough to pass validation." });

    expect(state.ok).toBe(false);
    expect(transaction).not.toHaveBeenCalled();
    expect(revalidateListingPaths).not.toHaveBeenCalled();
  });
});
