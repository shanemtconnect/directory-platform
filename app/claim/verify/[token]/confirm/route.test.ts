import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Viewer } from "@/lib/db/viewer";

const verifyClaimToken = vi.fn<(...a: unknown[]) => Promise<{ outcome: string; path?: string }>>();
const revalidatePath = vi.fn<(p: string) => void>();
const currentViewer = vi.fn<() => Promise<Viewer>>();
const TX = { marker: "tx" };

vi.mock("@/lib/db/client", () => ({
  db: { transaction: (fn: (tx: unknown) => Promise<unknown>) => fn(TX) },
}));
vi.mock("@/lib/auth/viewer", () => ({ currentViewer: () => currentViewer() }));
vi.mock("@/lib/db/queries/claims", () => ({
  verifyClaimToken: (...args: unknown[]) => verifyClaimToken(...args),
}));
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => revalidatePath(p) }));

function confirm(token: string, headers: Record<string, string> = {}) {
  return [
    new Request(`http://localhost:3211/claim/verify/${token}/confirm`, { method: "POST", headers }),
    { params: Promise.resolve({ token }) },
  ] as const;
}

describe("POST /claim/verify/[token]/confirm", () => {
  beforeEach(() => {
    verifyClaimToken.mockReset();
    revalidatePath.mockReset();
    currentViewer.mockReset().mockResolvedValue({ role: "public" });
  });

  it("hands the confirming request's ip to verifyClaimToken for the audit row", async () => {
    verifyClaimToken.mockResolvedValue({ outcome: "approved", path: "/leeds/the-old-mill" });
    const { POST } = await import("./route");

    const res = await POST(...confirm("tok-1", { "x-forwarded-for": "198.51.100.4, 203.0.113.7" }));

    expect(res.status).toBe(303);
    expect(new URL(res.headers.get("location")!).search).toBe("?claim=approved");
    // The LAST hop is the one our proxy wrote; the client controls the rest.
    expect(verifyClaimToken).toHaveBeenCalledWith(TX, { role: "public" }, "tok-1", "203.0.113.7");
    expect(revalidatePath).toHaveBeenCalledWith("/leeds/the-old-mill");
  });

  it("passes a null ip, never a placeholder, when no proxy header is present", async () => {
    verifyClaimToken.mockResolvedValue({ outcome: "expired" });
    const { POST } = await import("./route");

    const res = await POST(...confirm("tok-2"));

    expect(new URL(res.headers.get("location")!).search).toBe("?claim=expired");
    expect(verifyClaimToken).toHaveBeenCalledWith(TX, { role: "public" }, "tok-2", null);
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});
