import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Viewer } from "@/lib/db/viewer";

/**
 * The document confirm step, with the database mocked out.
 *
 * What the row update does is `attachClaimDocument` and is tested against a
 * real transaction in lib/db/queries/claims.test.ts. What is only testable
 * HERE is the shape check on the key the browser sends back: it has to be one
 * the server could have minted for THIS claim, or nothing is written and no
 * transaction is opened.
 */

const currentViewer = vi.fn<() => Promise<Viewer>>();
const attachClaimDocument = vi.fn<(...a: unknown[]) => Promise<boolean>>();
const notifyClaimSubmitted = vi.fn<(...a: unknown[]) => Promise<void>>();
const ensureProfile = vi.fn<(...a: unknown[]) => Promise<{ id: string }>>();

const HANDLE = { marker: "the transaction" };
const transaction = vi.fn(
  async <T,>(fn: (tx: unknown) => Promise<T>): Promise<T> => await fn(HANDLE),
);

vi.mock("next/headers", () => ({
  headers: () => Promise.resolve(new Headers({ "x-forwarded-for": "203.0.113.9" })),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/db/client", () => ({ db: { transaction: (fn: never) => transaction(fn) } }));
vi.mock("@/lib/auth/viewer", () => ({
  currentViewer: () => currentViewer(),
  requireAdmin: () => currentViewer(),
}));
vi.mock("@/lib/auth/profile", () => ({
  ensureProfile: (...args: unknown[]) => ensureProfile(...args),
}));
vi.mock("@/lib/db/queries/claims", () => ({
  attachClaimDocument: (...args: unknown[]) => attachClaimDocument(...args),
  decideClaim: vi.fn(),
  startDocumentClaim: vi.fn(),
  startDomainClaim: vi.fn(),
}));
vi.mock("@/lib/email/notify", () => ({
  notifyClaimSubmitted: (...args: unknown[]) => notifyClaimSubmitted(...args),
  notifyClaimDecided: vi.fn(),
  notifyClaimLink: vi.fn(),
}));

const OWNER: Viewer = { role: "user", userId: "user_owner" };
const CLAIM_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_CLAIM = "22222222-2222-4222-8222-222222222222";
const GOOD_KEY = `claims/${CLAIM_ID}/proof-0123456789abcdef.pdf`;

async function load() {
  return await import("./claim");
}

beforeEach(() => {
  vi.resetModules();
  currentViewer.mockReset().mockResolvedValue(OWNER);
  attachClaimDocument.mockReset().mockResolvedValue(true);
  notifyClaimSubmitted.mockReset().mockResolvedValue(undefined);
  ensureProfile.mockReset().mockResolvedValue({ id: "profile_owner" });
  transaction.mockClear();
});

describe("confirmClaimDocument", () => {
  it("records a key the server could have minted for this claim", async () => {
    const { confirmClaimDocument } = await load();

    const result = await confirmClaimDocument({ claimId: CLAIM_ID, key: GOOD_KEY });

    expect(result).toEqual({ ok: true });
    expect(attachClaimDocument).toHaveBeenCalledWith(HANDLE, OWNER, {
      claimId: CLAIM_ID,
      profileId: "profile_owner",
      path: GOOD_KEY,
      ip: "203.0.113.9",
    });
    expect(notifyClaimSubmitted).toHaveBeenCalledWith(HANDLE, OWNER, CLAIM_ID);
  });

  it("refuses a key that is not this claim's proof object, before opening a transaction", async () => {
    const { confirmClaimDocument } = await load();
    const suffix = "proof-0123456789abcdef.pdf";

    for (const key of [
      // Somebody else's document: the admin would be shown the wrong file.
      `claims/${OTHER_CLAIM}/${suffix}`,
      // Under this claim's prefix, then out of it.
      `claims/${CLAIM_ID}/../${OTHER_CLAIM}/${suffix}`,
      // Right directory, wrong name.
      `claims/${CLAIM_ID}/${OTHER_CLAIM}/${suffix}`,
      `claims/${CLAIM_ID}/evidence-0123456789abcdef.pdf`,
      // A type the upload policy would never have signed.
      `claims/${CLAIM_ID}/proof-0123456789abcdef.html`,
      `claims/${CLAIM_ID}/proof-0123456789abcdef.svg`,
      "",
    ]) {
      const result = await confirmClaimDocument({ claimId: CLAIM_ID, key });
      expect(result.ok, key).toBe(false);
      expect(result.message, key).toBeTruthy();
    }

    expect(transaction).not.toHaveBeenCalled();
    expect(attachClaimDocument).not.toHaveBeenCalled();
    expect(notifyClaimSubmitted).not.toHaveBeenCalled();
  });

  it("refuses a claim id that is not a uuid without looking anything up", async () => {
    const { confirmClaimDocument } = await load();

    const result = await confirmClaimDocument({
      claimId: "not-a-uuid",
      key: "claims/not-a-uuid/proof-0123456789abcdef.pdf",
    });

    expect(result.ok).toBe(false);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("asks for a sign-in before it reads the key at all", async () => {
    currentViewer.mockResolvedValue({ role: "public" });
    const { confirmClaimDocument } = await load();

    const result = await confirmClaimDocument({ claimId: CLAIM_ID, key: GOOD_KEY });

    expect(result).toEqual({ ok: false, message: "Please sign in to claim a listing." });
    expect(transaction).not.toHaveBeenCalled();
  });
});
