import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RegisterBacklinkResult } from "@/lib/db/queries/badges";
import type { RateLimitResult } from "@/lib/spam/rate-limit";
import type { Viewer } from "@/lib/db/viewer";

/**
 * The write behind /advertise/badge/mine.
 *
 * What the query does to the rows is tested against a real transaction in
 * lib/db/queries/badges.test.ts. What is only testable HERE is the layer the
 * form actually calls: that an anonymous poster is refused before anything is
 * spent, that the budget is checked before the transaction opens, that the
 * request address and the viewer's profile reach the query, and that every
 * refusal the query can return comes back as a sentence rather than a throw.
 */

const currentViewer = vi.fn<() => Promise<Viewer>>();
const ensureProfile = vi.fn<() => Promise<{ id: string; role: "owner" }>>();
const registerBacklink = vi.fn<() => Promise<RegisterBacklinkResult>>();
const limitPublicWrite = vi.fn<() => Promise<RateLimitResult>>();
const revalidatePath = vi.fn<(path: string) => void>();

const HANDLE = { marker: "the transaction" };
const transaction = vi.fn(
  async <T,>(fn: (tx: unknown) => Promise<T>): Promise<T> => await fn(HANDLE),
);

let requestHeaders = new Headers();

vi.mock("next/headers", () => ({ headers: () => Promise.resolve(requestHeaders) }));
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => revalidatePath(p) }));
vi.mock("@/lib/db/client", () => ({ db: { transaction: (fn: never) => transaction(fn) } }));
vi.mock("@/lib/auth/viewer", () => ({ currentViewer: () => currentViewer() }));
vi.mock("@/lib/auth/profile", () => ({
  ensureProfile: (...args: unknown[]) => ensureProfile(...(args as [])),
}));
vi.mock("@/lib/db/queries/badges", () => ({
  BACKLINK_URL_MAX_LENGTH: 2048,
  registerBacklink: (...args: unknown[]) => registerBacklink(...(args as [])),
}));
vi.mock("@/lib/spam/write-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/spam/write-limit")>();
  return {
    ...actual,
    limitPublicWrite: (...args: unknown[]) => limitPublicWrite(...(args as [])),
  };
});

const OWNER: Viewer = { role: "owner", userId: "user_owner" };
const PROFILE_ID = "44444444-4444-4444-8444-444444444444";
const LISTING_ID = "33333333-3333-4333-8333-333333333333";
const BADGE_ID = "55555555-5555-4555-8555-555555555555";
const URL_OK = "https://client.example/about";

const ALLOWED: RateLimitResult = { allowed: true, remaining: 9, retryAfterSeconds: 0 };
const BLOCKED: RateLimitResult = { allowed: false, remaining: 0, retryAfterSeconds: 1800 };

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
}

async function act(fields: Record<string, string>) {
  const { registerBacklinkAction } = await import("./badge");
  return await registerBacklinkAction({ status: "idle" }, form(fields));
}

beforeEach(() => {
  vi.resetModules();
  requestHeaders = new Headers({ "x-forwarded-for": "203.0.113.9" });
  currentViewer.mockReset().mockResolvedValue(OWNER);
  ensureProfile.mockReset().mockResolvedValue({ id: PROFILE_ID, role: "owner" });
  registerBacklink.mockReset().mockResolvedValue({
    outcome: "registered", badgeId: BADGE_ID, url: URL_OK,
  });
  limitPublicWrite.mockReset().mockResolvedValue(ALLOWED);
  revalidatePath.mockReset();
  transaction.mockClear();
});

describe("registerBacklinkAction", () => {
  it("refuses an anonymous poster before spending the budget or opening a transaction", async () => {
    currentViewer.mockResolvedValue({ role: "public", userId: "" } as unknown as Viewer);

    const state = await act({ listingId: LISTING_ID, url: URL_OK });

    expect(state.status).toBe("error");
    expect(state.message).toMatch(/sign in/i);
    expect(limitPublicWrite).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it("refuses a malformed listing id without touching Redis or the database", async () => {
    const state = await act({ listingId: "not-a-uuid", url: URL_OK });

    expect(state.status).toBe("error");
    expect(limitPublicWrite).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it("asks for a URL before spending one of the hourly attempts", async () => {
    const state = await act({ listingId: LISTING_ID, url: "   " });

    expect(state.status).toBe("error");
    expect(state.message).toMatch(/URL/i);
    expect(limitPublicWrite).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it("checks the 10-an-hour budget on the request's own headers, before the transaction", async () => {
    const { BADGE_BACKLINK_RATE_LIMIT } = await import("@/lib/spam/write-limit");
    limitPublicWrite.mockResolvedValue(BLOCKED);

    const state = await act({ listingId: LISTING_ID, url: URL_OK });

    expect(BADGE_BACKLINK_RATE_LIMIT).toEqual({ limit: 10, windowSeconds: 3600 });
    expect(limitPublicWrite).toHaveBeenCalledWith(
      "badge-backlink", requestHeaders, BADGE_BACKLINK_RATE_LIMIT,
    );
    expect(state.status).toBe("error");
    expect(state.message).toMatch(/30 minutes/);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("registers inside one transaction with the viewer's profile and the request address", async () => {
    const state = await act({ listingId: LISTING_ID, url: `  ${URL_OK}  ` });

    expect(ensureProfile).toHaveBeenCalledWith(HANDLE, OWNER);
    expect(registerBacklink).toHaveBeenCalledWith(HANDLE, OWNER, {
      listingId: LISTING_ID,
      url: URL_OK,
      actorProfileId: PROFILE_ID,
      ip: "203.0.113.9",
    });
    expect(state).toEqual({ status: "saved", url: URL_OK });
    expect(revalidatePath).toHaveBeenCalledWith("/advertise/badge/mine");
  });

  it.each<[RegisterBacklinkResult, RegExp]>([
    [{ outcome: "not-owner" }, /own/i],
    [{ outcome: "too-long" }, /2048/],
    [{ outcome: "invalid-url" }, /full address/i],
    [{ outcome: "wrong-scheme" }, /https?/i],
    [{ outcome: "no-website" }, /website/i],
    [{ outcome: "domain-mismatch", expected: "client.example" }, /client\.example/],
  ])("renders the query's refusal %j as a sentence", async (result, expected) => {
    registerBacklink.mockResolvedValue(result);

    const state = await act({ listingId: LISTING_ID, url: URL_OK });

    expect(state.status).toBe("error");
    expect(state.message).toMatch(expected);
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});
