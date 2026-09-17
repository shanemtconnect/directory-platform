import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Viewer } from "@/lib/db/viewer";
import type { OwnProfile } from "@/lib/db/queries/profile";

/**
 * The page reports an outcome it did not produce, so the one decision it owns
 * — "confirmed" or "not yet" — must not rest on the URL alone. These tests pin
 * it: `?error` always means not-yet; no error means confirmed only when the
 * user row agrees or there is no signed-in row to ask.
 */

const currentViewer = vi.fn<() => Promise<Viewer>>();
const ownProfile = vi.fn<() => Promise<OwnProfile>>();

vi.mock("@/lib/db/client", () => ({ db: {} }));
vi.mock("@/lib/auth/viewer", () => ({ currentViewer: () => currentViewer() }));
vi.mock("@/lib/db/queries/profile", () => ({ ownProfile: () => ownProfile() }));
vi.mock("@/components/auth/ResendVerificationButton", () => ({
  ResendVerificationButton: () => null,
}));

const { default: VerifyEmailPage } = await import("./page");

const PROFILE: OwnProfile = {
  profileId: "00000000-0000-0000-0000-000000000001",
  role: "user",
  name: "Sam",
  phone: null,
  marketingOptIn: false,
  email: "sam@example.test",
  emailVerified: false,
};

async function render(params: Record<string, string | undefined>): Promise<string> {
  const el = await VerifyEmailPage({ searchParams: Promise.resolve(params) });
  return JSON.stringify(el);
}

beforeEach(() => {
  currentViewer.mockReset();
  ownProfile.mockReset();
});

describe("VerifyEmailPage", () => {
  it("confirms for a signed-out visitor who followed a link with no error", async () => {
    currentViewer.mockResolvedValue({ role: "public" });
    const out = await render({});
    expect(out).toContain("verify-email-ok");
    expect(out).not.toContain("verify-email-failed");
    expect(ownProfile).not.toHaveBeenCalled();
  });

  it("confirms for a signed-in viewer whose user row says verified", async () => {
    currentViewer.mockResolvedValue({ role: "user", userId: "u_1" });
    ownProfile.mockResolvedValue({ ...PROFILE, emailVerified: true });
    const out = await render({});
    expect(out).toContain("verify-email-ok");
  });

  it("does NOT confirm a signed-in viewer who is still unverified, even with no ?error", async () => {
    // A typed or bookmarked visit: the URL says nothing went wrong, the row says
    // nothing has happened yet. The row wins, and the resend button is offered.
    currentViewer.mockResolvedValue({ role: "user", userId: "u_1" });
    ownProfile.mockResolvedValue(PROFILE);
    const out = await render({});
    expect(out).not.toContain("verify-email-ok");
    expect(out).toContain("verify-email-failed");
    expect(out).toContain("Not confirmed yet");
    // The resend button, with the address from the row rather than the URL.
    expect(out).toContain('"email":"sam@example.test"');
  });

  it("reports an expired link whatever the row says", async () => {
    currentViewer.mockResolvedValue({ role: "user", userId: "u_1" });
    ownProfile.mockResolvedValue({ ...PROFILE, emailVerified: true });
    const out = await render({ error: "INVALID_TOKEN" });
    expect(out).not.toContain("verify-email-ok");
    expect(out).toContain("That link has expired");
  });

  it("sends a signed-out visitor with a dead link to sign in", async () => {
    currentViewer.mockResolvedValue({ role: "public" });
    const out = await render({ error: "INVALID_TOKEN" });
    expect(out).toContain("verify-email-failed");
    expect(out).toContain("/login?next=/account");
    expect(out).not.toContain('"email":');
  });
});
