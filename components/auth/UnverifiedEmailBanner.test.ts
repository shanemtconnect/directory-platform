import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Viewer } from "@/lib/db/viewer";
import type { OwnProfile } from "@/lib/db/queries/profile";

/**
 * The banner is a server component that decides for itself whether to render,
 * so the host page has no condition to get wrong. These tests pin the
 * decision: nothing for a signed-out or verified viewer, the notice with the
 * address for an unverified one.
 */

const currentViewer = vi.fn<() => Promise<Viewer>>();
const ownProfile = vi.fn<() => Promise<OwnProfile>>();

vi.mock("@/lib/db/client", () => ({ db: {} }));
vi.mock("@/lib/auth/viewer", () => ({ currentViewer: () => currentViewer() }));
vi.mock("@/lib/db/queries/profile", () => ({ ownProfile: () => ownProfile() }));

const { UnverifiedEmailBanner } = await import("./UnverifiedEmailBanner");

const PROFILE: OwnProfile = {
  profileId: "00000000-0000-0000-0000-000000000001",
  role: "user",
  name: "Sam",
  phone: null,
  marketingOptIn: false,
  email: "sam@example.test",
  emailVerified: false,
};

interface RenderedElement {
  props: Record<string, unknown>;
}

function isElement(v: unknown): v is RenderedElement {
  return typeof v === "object" && v !== null && "props" in v;
}

beforeEach(() => {
  currentViewer.mockReset();
  ownProfile.mockReset();
});

describe("UnverifiedEmailBanner", () => {
  it("renders nothing for a signed-out viewer, without touching the profile", async () => {
    currentViewer.mockResolvedValue({ role: "public" });
    expect(await UnverifiedEmailBanner()).toBeNull();
    expect(ownProfile).not.toHaveBeenCalled();
  });

  it("renders nothing once the address is verified", async () => {
    currentViewer.mockResolvedValue({ role: "user", userId: "u_1" });
    ownProfile.mockResolvedValue({ ...PROFILE, emailVerified: true });
    expect(await UnverifiedEmailBanner()).toBeNull();
  });

  it("shows the notice, with the address, while it is not", async () => {
    currentViewer.mockResolvedValue({ role: "user", userId: "u_1" });
    ownProfile.mockResolvedValue(PROFILE);
    const el = await UnverifiedEmailBanner();
    expect(isElement(el)).toBe(true);
    if (!isElement(el)) return;
    expect(el.props["data-testid"]).toBe("unverified-email-banner");
    // A notice, not an alert: nothing is broken and nothing is blocked.
    expect(el.props.role).toBe("status");
    expect(JSON.stringify(el.props.children)).toContain("sam@example.test");
  });

  it("is a notice for owners and admins too — verification gates nothing", async () => {
    currentViewer.mockResolvedValue({ role: "owner", userId: "u_2" });
    ownProfile.mockResolvedValue({ ...PROFILE, role: "owner" });
    const el = await UnverifiedEmailBanner();
    expect(isElement(el) && el.props["data-testid"]).toBe("unverified-email-banner");
  });
});
