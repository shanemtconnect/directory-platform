import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Viewer } from "@/lib/db/viewer";
import type { CreateJobResult, JobDecisionResult } from "@/lib/db/queries/job-board";
import type { RateLimitResult } from "@/lib/spam/rate-limit";
import type { TurnstileResult } from "@/lib/spam/turnstile";
import type { PayPalOrdersClient } from "@/lib/billing/orders";

/**
 * The post action's gate ORDER, with the database mocked out.
 *
 * What the insert does is `createJob` and is tested against a real
 * transaction in lib/db/queries/job-board.test.ts. What is only testable here
 * is the order of the gates — honeypot, validate, rate limit, Turnstile,
 * transaction — and what the action does with each answer: the free path
 * lands on thanks, the owed path creates the order inside the transaction
 * and sends the buyer to PayPal, and every refusal spends nothing after it.
 */

class Redirect extends Error {
  constructor(public readonly to: string) {
    super(`NEXT_REDIRECT ${to}`);
  }
}

const currentViewer = vi.fn<() => Promise<Viewer>>();
const requireAdmin = vi.fn<() => Promise<Viewer>>();
const createJob = vi.fn<(...a: unknown[]) => Promise<CreateJobResult>>();
const attachJobOrder = vi.fn<(...a: unknown[]) => Promise<void>>();
const approveJob = vi.fn<(...a: unknown[]) => Promise<JobDecisionResult>>();
const rejectJob = vi.fn<(...a: unknown[]) => Promise<JobDecisionResult>>();
const jobPaths = vi.fn<(...a: unknown[]) => Promise<string[]>>();
const recordJobApply = vi.fn<(...a: unknown[]) => Promise<boolean>>();
const limitPublicWrite = vi.fn<(...a: unknown[]) => Promise<RateLimitResult>>();
const verifyTurnstile = vi.fn<(...a: unknown[]) => Promise<TurnstileResult>>();
const revalidateListingPaths = vi.fn<(paths: readonly string[]) => void>();
const revalidatePath = vi.fn<(path: string) => void>();
const createOrder = vi.fn<PayPalOrdersClient["createOrder"]>();
let ordersClient: PayPalOrdersClient | null = null;
let flagOn = true;

const HANDLE = { marker: "the transaction" };
const transaction = vi.fn(async <T,>(fn: (tx: unknown) => Promise<T>): Promise<T> => await fn(HANDLE));

vi.mock("next/headers", () => ({
  headers: () => Promise.resolve(new Headers({ "x-forwarded-for": "203.0.113.9" })),
}));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Redirect(to);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => revalidatePath(p) }));
vi.mock("@/lib/db/client", () => ({ db: { transaction: (fn: never) => transaction(fn) } }));
vi.mock("@/lib/features/flags", () => ({
  get features() {
    return { jobBoard: flagOn };
  },
}));
vi.mock("@/lib/auth/viewer", () => ({
  currentViewer: () => currentViewer(),
  requireAdmin: () => requireAdmin(),
}));
vi.mock("@/lib/auth/profile", () => ({
  ensureProfile: async () => ({ id: "33333333-3333-4333-8333-333333333333", role: "user" }),
}));
vi.mock("@/lib/db/queries/job-board", () => ({
  createJob: (...a: unknown[]) => createJob(...a),
  attachJobOrder: (...a: unknown[]) => attachJobOrder(...a),
  approveJob: (...a: unknown[]) => approveJob(...a),
  rejectJob: (...a: unknown[]) => rejectJob(...a),
  jobPaths: (...a: unknown[]) => jobPaths(...a),
  recordJobApply: (...a: unknown[]) => recordJobApply(...a),
}));
vi.mock("@/lib/spam/write-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/spam/write-limit")>()),
  limitPublicWrite: (...a: unknown[]) => limitPublicWrite(...a),
}));
vi.mock("@/lib/spam/turnstile", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/spam/turnstile")>()),
  verifyTurnstile: (...a: unknown[]) => verifyTurnstile(...a),
}));
vi.mock("@/lib/billing/orders", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/billing/orders")>()),
  getPayPalOrdersClient: () => ordersClient,
}));
vi.mock("@/lib/revalidate/listing", () => ({
  revalidateListingPaths: (paths: readonly string[]) => revalidateListingPaths(paths),
}));

const CITY = "11111111-1111-4111-8111-111111111111";
const CATEGORY = "22222222-2222-4222-8222-222222222222";
const LISTING = "44444444-4444-4444-8444-444444444444";
const JOB = "55555555-5555-4555-8555-555555555555";
const allowed: RateLimitResult = { allowed: true, remaining: 2, retryAfterSeconds: 0 };
const blocked: RateLimitResult = { allowed: false, remaining: 0, retryAfterSeconds: 7200 };

function form(over: Record<string, string> = {}): FormData {
  const f = new FormData();
  const base: Record<string, string> = {
    title: "Weekend coordinator",
    description: "Someone to run the Saturday diary and keep the suppliers in step through the season.",
    companyName: "The Old Mill",
    posterName: "Pat Owner",
    posterEmail: "pat@example.co.uk",
    cityId: CITY,
    categoryId: CATEGORY,
    applyMethod: "email",
    applyEmail: "jobs@example.co.uk",
    "cf-turnstile-response": "tok",
    ...over,
  };
  for (const [k, v] of Object.entries(base)) f.set(k, v);
  return f;
}

async function post(fields: Record<string, string> = {}) {
  const { postJob } = await import("./jobs");
  return postJob({ status: "idle" }, form(fields));
}

beforeEach(() => {
  vi.resetModules();
  flagOn = true;
  ordersClient = null;
  currentViewer.mockReset().mockResolvedValue({ role: "public" });
  requireAdmin.mockReset().mockResolvedValue({ role: "admin", userId: "user_admin" });
  createJob.mockReset().mockResolvedValue({ outcome: "created", jobId: JOB, free: true });
  attachJobOrder.mockReset();
  approveJob.mockReset();
  rejectJob.mockReset();
  jobPaths.mockReset().mockResolvedValue(["/jobs", `/jobs/${JOB}`]);
  recordJobApply.mockReset().mockResolvedValue(true);
  limitPublicWrite.mockReset().mockResolvedValue(allowed);
  verifyTurnstile.mockReset().mockResolvedValue({ ok: true, skipped: false });
  revalidateListingPaths.mockReset();
  revalidatePath.mockReset();
  createOrder.mockReset();
  transaction.mockClear();
});

describe("postJob", () => {
  it("404s every action when the flag is off", async () => {
    flagOn = false;
    await expect(post()).rejects.toThrow("NOT_FOUND");
    const { approveJobAction, recordApplyClick } = await import("./jobs");
    await expect(approveJobAction(form({ jobId: JOB }))).rejects.toThrow("NOT_FOUND");
    await expect(recordApplyClick(JOB)).rejects.toThrow("NOT_FOUND");
    expect(createJob).not.toHaveBeenCalled();
  });

  it("swallows the honeypot before anything is spent", async () => {
    await expect(post({ company_website: "http://spam.example" })).rejects.toThrow("/post-a-job/thanks");
    expect(limitPublicWrite).not.toHaveBeenCalled();
    expect(verifyTurnstile).not.toHaveBeenCalled();
    expect(createJob).not.toHaveBeenCalled();
  });

  it("validates before the rate limit and the rate limit before Turnstile", async () => {
    const invalid = await post({ title: "x" });
    expect(invalid.status).toBe("error");
    expect(invalid.fieldErrors).toHaveProperty("title");
    expect(limitPublicWrite).not.toHaveBeenCalled();

    limitPublicWrite.mockResolvedValue(blocked);
    const limited = await post();
    expect(limited.message).toMatch(/2 hours/);
    expect(verifyTurnstile).not.toHaveBeenCalled();
    expect(limitPublicWrite).toHaveBeenCalledWith("post-job", expect.any(Headers), { limit: 3, windowSeconds: 86_400 });

    limitPublicWrite.mockResolvedValue(allowed);
    verifyTurnstile.mockResolvedValue({ ok: false, skipped: false, reason: "invalid-input-response" });
    const bot = await post();
    expect(bot.message).toMatch(/human/);
    expect(createJob).not.toHaveBeenCalled();
  });

  it("a free post lands on thanks with no order created", async () => {
    await expect(post()).rejects.toThrow("/post-a-job/thanks");
    expect(createJob).toHaveBeenCalledWith(HANDLE, { role: "public" }, expect.objectContaining({
      title: "Weekend coordinator",
      posterProfileId: null,
      listingId: null,
      ip: "203.0.113.9",
    }));
    expect(attachJobOrder).not.toHaveBeenCalled();
  });

  it("refuses a free-on-listing post from a stranger before the budget or the Turnstile token is spent", async () => {
    const state = await post({ listingId: LISTING });
    expect(state.fieldErrors).toHaveProperty("listingId");
    expect(limitPublicWrite).not.toHaveBeenCalled();
    expect(verifyTurnstile).not.toHaveBeenCalled();
    expect(createJob).not.toHaveBeenCalled();
  });

  it("an owed post creates the PayPal order inside the transaction and sends the buyer there", async () => {
    createJob.mockResolvedValue({ outcome: "created", jobId: JOB, free: false });
    createOrder.mockResolvedValue({ id: "ORDER-1", status: "PAYER_ACTION_REQUIRED", approveUrl: "https://www.sandbox.paypal.com/checkoutnow?token=ORDER-1" });
    ordersClient = { createOrder, captureOrder: vi.fn() };

    await expect(post()).rejects.toThrow("checkoutnow?token=ORDER-1");
    expect(createOrder).toHaveBeenCalledWith(expect.objectContaining({ customId: JOB }));
    expect(attachJobOrder).toHaveBeenCalledWith(HANDLE, { role: "public" }, { jobId: JOB, providerOrderId: "ORDER-1" });
    // Inside: the row and the order commit together or not at all.
    expect(transaction.mock.calls).toHaveLength(1);
  });

  it("an owed post with no PayPal is refused, and the transaction's answer says why", async () => {
    createJob.mockResolvedValue({ outcome: "created", jobId: JOB, free: false });
    const state = await post();
    expect(state.status).toBe("error");
    expect(state.message).toMatch(/not set up/);
    expect(attachJobOrder).not.toHaveBeenCalled();
  });

  it("puts the query's refusals on the field that caused them", async () => {
    createJob.mockResolvedValue({ outcome: "not-verified-listing" });
    currentViewer.mockResolvedValue({ role: "user", userId: "u" });
    expect((await post({ listingId: LISTING })).fieldErrors).toHaveProperty("listingId");
    createJob.mockResolvedValue({ outcome: "unknown-category" });
    expect((await post()).fieldErrors).toHaveProperty("categoryId");
  });
});

describe("recordApplyClick", () => {
  it("counts within its budget and ignores junk", async () => {
    const { recordApplyClick } = await import("./jobs");
    await recordApplyClick(JOB);
    expect(recordJobApply).toHaveBeenCalledWith(expect.anything(), { role: "public" }, JOB);
    await recordApplyClick("junk");
    limitPublicWrite.mockResolvedValue(blocked);
    await recordApplyClick(JOB);
    expect(recordJobApply).toHaveBeenCalledTimes(1);
  });
});

describe("admin decisions", () => {
  it("approve re-checks admin, passes the ip, busts the board once the transaction is back", async () => {
    approveJob.mockResolvedValue({ outcome: "approved", jobId: JOB });
    const { approveJobAction } = await import("./jobs");
    await expect(approveJobAction(form({ jobId: JOB }))).rejects.toThrow("/admin/jobs");
    expect(requireAdmin).toHaveBeenCalled();
    expect(approveJob).toHaveBeenCalledWith(HANDLE, { role: "admin", userId: "user_admin" }, JOB, { ip: "203.0.113.9" });
    expect(revalidateListingPaths).toHaveBeenCalledWith(["/jobs", `/jobs/${JOB}`]);
    expect(revalidatePath).toHaveBeenCalledWith("/admin/jobs");
    expect(transaction.mock.results[0]?.type).toBe("return");
  });

  it("approve busts nothing when the decision did not happen", async () => {
    approveJob.mockResolvedValue({ outcome: "unpaid" });
    const { approveJobAction } = await import("./jobs");
    await expect(approveJobAction(form({ jobId: JOB }))).rejects.toThrow("/admin/jobs");
    expect(revalidateListingPaths).not.toHaveBeenCalled();
  });

  it("a non-admin is refused before the transaction", async () => {
    requireAdmin.mockRejectedValue(new Error("FORBIDDEN"));
    const { approveJobAction, rejectJobAction } = await import("./jobs");
    await expect(approveJobAction(form({ jobId: JOB }))).rejects.toThrow("FORBIDDEN");
    await expect(rejectJobAction({ status: "idle" }, form({ jobId: JOB, reason: "x" }))).rejects.toThrow("FORBIDDEN");
    expect(transaction).not.toHaveBeenCalled();
  });

  it("reject wants a reason and hands it through", async () => {
    rejectJob.mockResolvedValue({ outcome: "reason-required" });
    const { rejectJobAction } = await import("./jobs");
    expect((await rejectJobAction({ status: "idle" }, form({ jobId: JOB, reason: " " }))).status).toBe("error");
    rejectJob.mockResolvedValue({ outcome: "rejected", jobId: JOB });
    await expect(rejectJobAction({ status: "idle" }, form({ jobId: JOB, reason: "Not real." }))).rejects.toThrow("/admin/jobs");
    expect(rejectJob).toHaveBeenLastCalledWith(HANDLE, expect.anything(), JOB, { ip: "203.0.113.9", reason: "Not real." });
  });
});
