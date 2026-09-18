import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Viewer } from "@/lib/db/viewer";
import type { OwnerBadgeStatus } from "@/lib/db/queries/badge-owner";
import type { OwnerListing } from "@/lib/db/queries/owner";
import { elements, links } from "@/test/elements";

/**
 * The owner's half of the badge page.
 *
 * /advertise/badge is static and shows a worked example; this route is the
 * dynamic, session-gated one that shows a real snippet and asks where it was
 * put. What is only testable here is the gate and the wiring: an anonymous
 * viewer is sent to sign in and back, a listing the viewer does not own sends
 * them to the public page rather than confirming the row exists, and the
 * form and gallery are mounted with the owner-scoped query's answer.
 */

class Redirect extends Error {
  constructor(public readonly to: string) {
    super(`NEXT_REDIRECT ${to}`);
  }
}

const currentViewer = vi.fn<() => Promise<Viewer>>();
const ensureProfile = vi.fn<() => Promise<{ id: string; role: "owner" }>>();
const ownerBadgeStatus = vi.fn<() => Promise<OwnerBadgeStatus | null>>();
const ownerListings = vi.fn<() => Promise<OwnerListing[]>>();

const DB = { marker: "the pool" };

vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Redirect(to);
  },
}));
vi.mock("@/lib/db/client", () => ({ db: DB }));
vi.mock("@/lib/auth/viewer", () => ({ currentViewer: () => currentViewer() }));
vi.mock("@/lib/auth/profile", () => ({
  ensureProfile: (...args: unknown[]) => ensureProfile(...(args as [])),
}));
vi.mock("@/lib/db/queries/badge-owner", () => ({
  ownerBadgeStatus: (...args: unknown[]) => ownerBadgeStatus(...(args as [])),
}));
vi.mock("@/lib/db/queries/owner", () => ({
  ownerListings: (...args: unknown[]) => ownerListings(...(args as [])),
}));

const OWNER: Viewer = { role: "owner", userId: "user_owner" };
const LISTING_ID = "33333333-3333-4333-8333-333333333333";

const STATUS: OwnerBadgeStatus = {
  id: LISTING_ID,
  name: "The Old Hall",
  path: "/richmond/the-old-hall",
  website: "https://www.client.example/",
  cityName: "Richmond",
  categoryName: "Barns",
  claimStatus: "verified",
  ratingAvg: "4.8",
  ratingCount: 27,
  backlinkUrl: "https://client.example/about",
  backlinkVerified: true,
  lastCheckedAt: new Date("2026-09-12T12:00:00Z"),
};

async function render(id?: string) {
  const { default: page } = await import("./page");
  return await page({ searchParams: Promise.resolve(id === undefined ? {} : { id }) });
}

beforeEach(() => {
  vi.resetModules();
  currentViewer.mockReset().mockResolvedValue(OWNER);
  ensureProfile.mockReset().mockResolvedValue({ id: "profile", role: "owner" });
  ownerBadgeStatus.mockReset().mockResolvedValue(STATUS);
  ownerListings.mockReset().mockResolvedValue([]);
});

describe("/advertise/badge/mine", () => {
  it("sends an anonymous viewer to sign in, and back here afterwards", async () => {
    currentViewer.mockResolvedValue({ role: "public", userId: "" } as unknown as Viewer);

    await expect(render(LISTING_ID)).rejects.toMatchObject({
      to: `/login?next=${encodeURIComponent(`/advertise/badge/mine?id=${LISTING_ID}`)}`,
    });
    expect(ownerBadgeStatus).not.toHaveBeenCalled();
  });

  it("sends a viewer who does not own the listing to the public page, not a 404", async () => {
    // A 404 would say "no such listing" to someone who can see it exists; the
    // public page shows them the worked example, which is all they get.
    ownerBadgeStatus.mockResolvedValue(null);

    await expect(render(LISTING_ID)).rejects.toMatchObject({ to: "/advertise/badge" });
    expect(ownerBadgeStatus).toHaveBeenCalledWith(DB, OWNER, LISTING_ID);
  });

  it("mounts the form and the gallery for the owner's own listing", async () => {
    const { BacklinkForm } = await import("@/components/advertise/BacklinkForm");
    const { BadgeGallery } = await import("@/components/advertise/BadgeGallery");
    const tree = await render(LISTING_ID);

    const form = [...elements(tree)].find((el) => el.type === BacklinkForm);
    expect(form).toBeDefined();
    expect(form!.props).toMatchObject({
      listingId: LISTING_ID,
      currentUrl: "https://client.example/about",
    });

    const gallery = [...elements(tree)].find((el) => el.type === BadgeGallery);
    expect(gallery).toBeDefined();
    expect(gallery!.props).toMatchObject({
      base: { listingId: LISTING_ID, listingName: "The Old Hall", listingPath: "/richmond/the-old-hall" },
      verified: true,
      ratingAvg: "4.8",
      ratingCount: 27,
    });
  });

  it("lists the viewer's listings when no id is given", async () => {
    ownerListings.mockResolvedValue([
      {
        id: LISTING_ID, name: "The Old Hall", path: "/richmond/the-old-hall", status: "published",
        tier: "free", claimStatus: "claimed", enquiryCount: 0, unreadEnquiries: 0,
      },
    ]);
    const tree = await render();

    expect(ownerBadgeStatus).not.toHaveBeenCalled();
    expect(links(tree)).toContainEqual({
      href: `/advertise/badge/mine?id=${LISTING_ID}`,
      text: "The Old Hall",
    });
  });

  it("points a viewer with nothing owned at the claim route", async () => {
    const tree = await render();
    expect(links(tree).some((l) => l.href === "/account")).toBe(true);
  });
});
