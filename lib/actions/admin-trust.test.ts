import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DecisionResult } from "@/lib/db/queries/trust";
import type { SubmissionDetail } from "@/lib/db/queries/admin/submissions";
import type { Viewer } from "@/lib/db/viewer";

/**
 * The four writes behind /admin/reports and /admin/removals.
 *
 * These are unit tests with the database mocked out, and deliberately so: what
 * each decision does to the rows is Task 18's `lib/db/queries/trust.ts` and is
 * tested there against a real transaction. What is only testable HERE is the
 * layer the queue pages actually call — that it refuses a non-admin before it
 * opens a transaction, that the moderator's IP reaches the audit trail, that a
 * second click on a decided row says so instead of silently doing nothing, and
 * that a takedown busts the caches the removed listing is sitting in.
 */

const requireAdmin = vi.fn<() => Promise<Viewer>>();
const actionReport = vi.fn<() => Promise<DecisionResult>>();
const actionRemovalRequest = vi.fn<() => Promise<DecisionResult>>();
const submissionDetail = vi.fn<() => Promise<SubmissionDetail | null>>();
const revalidatePath = vi.fn<(path: string) => void>();

/** The handle the action hands to the query functions. */
const HANDLE = { marker: "the transaction" };
const transaction = vi.fn(
  async <T,>(fn: (tx: unknown) => Promise<T>): Promise<T> => await fn(HANDLE),
);

let requestHeaders = new Headers();

vi.mock("next/headers", () => ({ headers: () => Promise.resolve(requestHeaders) }));
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => revalidatePath(p) }));
vi.mock("@/lib/db/client", () => ({ db: { transaction: (fn: never) => transaction(fn) } }));
vi.mock("@/lib/auth/viewer", () => ({ requireAdmin: () => requireAdmin() }));
vi.mock("@/lib/db/queries/trust", () => ({
  actionReport: (...args: unknown[]) => actionReport(...(args as [])),
  actionRemovalRequest: (...args: unknown[]) => actionRemovalRequest(...(args as [])),
}));
vi.mock("@/lib/db/queries/admin/submissions", () => ({
  submissionDetail: (...args: unknown[]) => submissionDetail(...(args as [])),
}));

const ADMIN: Viewer = { role: "admin", userId: "user_admin" };
const REPORT_ID = "11111111-1111-4111-8111-111111111111";
const REMOVAL_ID = "22222222-2222-4222-8222-222222222222";
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
  return await import("./admin-trust");
}

beforeEach(() => {
  vi.resetModules();
  requestHeaders = new Headers({ "x-forwarded-for": "203.0.113.9" });
  requireAdmin.mockReset().mockResolvedValue(ADMIN);
  actionReport.mockReset().mockResolvedValue({ outcome: "updated", id: REPORT_ID });
  actionRemovalRequest.mockReset().mockResolvedValue({ outcome: "updated", id: REMOVAL_ID });
  submissionDetail.mockReset().mockResolvedValue(DETAIL);
  revalidatePath.mockReset();
  transaction.mockClear();
});

describe("report decisions", () => {
  it("refuses a viewer who is not an admin before it opens a transaction", async () => {
    requireAdmin.mockRejectedValue(new Error("FORBIDDEN"));
    const { dismissReportAction } = await load();

    await expect(dismissReportAction({ status: "idle" }, form({ reportId: REPORT_ID })))
      .rejects.toThrow("FORBIDDEN");

    expect(transaction).not.toHaveBeenCalled();
    expect(actionReport).not.toHaveBeenCalled();
  });

  it("records the moderator's own IP with the decision", async () => {
    const { dismissReportAction } = await load();

    await dismissReportAction({ status: "idle" }, form({ reportId: REPORT_ID }));

    expect(actionReport).toHaveBeenCalledWith(HANDLE, ADMIN, REPORT_ID, "dismissed", {
      ip: "203.0.113.9",
    });
  });

  it("passes a null IP rather than a placeholder when no proxy header identifies the caller", async () => {
    requestHeaders = new Headers();
    const { markReportActionedAction } = await load();

    await markReportActionedAction({ status: "idle" }, form({ reportId: REPORT_ID }));

    expect(actionReport).toHaveBeenCalledWith(HANDLE, ADMIN, REPORT_ID, "actioned", { ip: null });
  });

  it("marks a report actioned rather than dismissed", async () => {
    const { markReportActionedAction } = await load();

    const state = await markReportActionedAction({ status: "idle" }, form({ reportId: REPORT_ID }));

    expect(actionReport).toHaveBeenCalledWith(HANDLE, ADMIN, REPORT_ID, "actioned", {
      ip: "203.0.113.9",
    });
    expect(state.status).toBe("done");
  });

  it("does not open a transaction for an id that is not a uuid", async () => {
    const { dismissReportAction } = await load();

    const state = await dismissReportAction({ status: "idle" }, form({ reportId: "nonsense" }));

    expect(transaction).not.toHaveBeenCalled();
    expect(state.status).toBe("error");
  });

  it("says so when somebody else already decided it", async () => {
    actionReport.mockResolvedValue({ outcome: "not-open" });
    const { dismissReportAction } = await load();

    const state = await dismissReportAction({ status: "idle" }, form({ reportId: REPORT_ID }));

    expect(state.status).toBe("error");
    expect(state.message).toMatch(/already/i);
  });

  it("says so when the report is gone", async () => {
    actionReport.mockResolvedValue({ outcome: "unknown" });
    const { dismissReportAction } = await load();

    const state = await dismissReportAction({ status: "idle" }, form({ reportId: REPORT_ID }));

    expect(state.status).toBe("error");
    expect(state.message).toMatch(/not there|gone/i);
  });

  it("refreshes the queue and the dashboard it is counted on", async () => {
    const { dismissReportAction } = await load();

    await dismissReportAction({ status: "idle" }, form({ reportId: REPORT_ID }));

    expect(revalidatePath).toHaveBeenCalledWith("/admin/reports");
    expect(revalidatePath).toHaveBeenCalledWith("/admin");
  });

  it("leaves the public cache alone — a report decision changes nothing a visitor sees", async () => {
    const { dismissReportAction } = await load();

    await dismissReportAction({ status: "idle" }, form({ reportId: REPORT_ID }));

    expect(revalidatePath).not.toHaveBeenCalledWith("/richmond");
  });
});

describe("removal decisions", () => {
  it("refuses a viewer who is not an admin before it opens a transaction", async () => {
    requireAdmin.mockRejectedValue(new Error("FORBIDDEN"));
    const { actionRemovalAction } = await load();

    await expect(
      actionRemovalAction(
        { status: "idle" },
        form({ removalRequestId: REMOVAL_ID, listingId: LISTING_ID }),
      ),
    ).rejects.toThrow("FORBIDDEN");

    expect(transaction).not.toHaveBeenCalled();
    expect(actionRemovalRequest).not.toHaveBeenCalled();
  });

  it("records the moderator's own IP with the takedown", async () => {
    const { actionRemovalAction } = await load();

    await actionRemovalAction(
      { status: "idle" },
      form({ removalRequestId: REMOVAL_ID, listingId: LISTING_ID }),
    );

    expect(actionRemovalRequest).toHaveBeenCalledWith(HANDLE, ADMIN, REMOVAL_ID, "actioned", {
      ip: "203.0.113.9",
    });
  });

  it("rejects rather than actions when the reject button is used", async () => {
    const { rejectRemovalAction } = await load();

    await rejectRemovalAction(
      { status: "idle" },
      form({ removalRequestId: REMOVAL_ID, listingId: LISTING_ID }),
    );

    expect(actionRemovalRequest).toHaveBeenCalledWith(HANDLE, ADMIN, REMOVAL_ID, "rejected", {
      ip: "203.0.113.9",
    });
  });

  it("busts every cached page the removed listing was on", async () => {
    const { actionRemovalAction } = await load();

    await actionRemovalAction(
      { status: "idle" },
      form({ removalRequestId: REMOVAL_ID, listingId: LISTING_ID }),
    );

    // Its own page, the town it was in, and the pillar page inside that town.
    expect(revalidatePath).toHaveBeenCalledWith("/richmond/the-old-hall");
    expect(revalidatePath).toHaveBeenCalledWith("/richmond");
    expect(revalidatePath).toHaveBeenCalledWith("/richmond/barns");
    expect(revalidatePath).toHaveBeenCalledWith("/admin/removals");
  });

  it("reads the listing's paths inside the same transaction, while it is still there to read", async () => {
    const order: string[] = [];
    submissionDetail.mockImplementation(async () => {
      order.push("detail");
      return DETAIL;
    });
    actionRemovalRequest.mockImplementation(async () => {
      order.push("decision");
      return { outcome: "updated", id: REMOVAL_ID };
    });
    const { actionRemovalAction } = await load();

    await actionRemovalAction(
      { status: "idle" },
      form({ removalRequestId: REMOVAL_ID, listingId: LISTING_ID }),
    );

    expect(order).toEqual(["detail", "decision"]);
    expect(submissionDetail).toHaveBeenCalledWith(HANDLE, ADMIN, LISTING_ID);
  });

  it("does not bust the public cache for a decision that did not happen", async () => {
    actionRemovalRequest.mockResolvedValue({ outcome: "not-open" });
    const { actionRemovalAction } = await load();

    const state = await actionRemovalAction(
      { status: "idle" },
      form({ removalRequestId: REMOVAL_ID, listingId: LISTING_ID }),
    );

    expect(state.status).toBe("error");
    expect(state.message).toMatch(/already/i);
    expect(revalidatePath).not.toHaveBeenCalledWith("/richmond");
  });

  it("still decides when the form carries no listing id to revalidate from", async () => {
    const { actionRemovalAction } = await load();

    const state = await actionRemovalAction(
      { status: "idle" },
      form({ removalRequestId: REMOVAL_ID }),
    );

    expect(submissionDetail).not.toHaveBeenCalled();
    expect(actionRemovalRequest).toHaveBeenCalled();
    expect(state.status).toBe("done");
  });

  it("does not open a transaction for an id that is not a uuid", async () => {
    const { rejectRemovalAction } = await load();

    const state = await rejectRemovalAction({ status: "idle" }, form({ removalRequestId: "x" }));

    expect(transaction).not.toHaveBeenCalled();
    expect(state.status).toBe("error");
  });
});
