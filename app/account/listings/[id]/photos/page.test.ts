import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Viewer } from "@/lib/db/viewer";
import type { OwnerListingDetail } from "@/lib/db/queries/owner";
import type { OwnerPhoto, PhotoQuota } from "@/lib/db/queries/photos";
import { elements } from "@/test/elements";

/**
 * The owner's photos page. What is testable here is the wiring: the page
 * asks the owner-gated queries, hands the manager absolute thumbnail URLs
 * and the tier's quota, tells it whether uploads are possible at all, and
 * 404s for a listing the viewer does not own.
 */

class NotFound extends Error {}

const currentViewer = vi.fn<() => Promise<Viewer>>();
const ownerListing = vi.fn<() => Promise<OwnerListingDetail | null>>();
const ownerPhotos = vi.fn<() => Promise<OwnerPhoto[]>>();
const ownerPhotoQuota = vi.fn<() => Promise<PhotoQuota | null>>();

const DB = { marker: "the pool" };
const ENV = { ...process.env };

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new NotFound("NEXT_NOT_FOUND");
  },
}));
vi.mock("@/lib/db/client", () => ({ db: DB }));
vi.mock("@/lib/auth/viewer", () => ({ currentViewer: () => currentViewer() }));
vi.mock("@/lib/db/queries/owner", () => ({
  ownerListing: (...args: unknown[]) => ownerListing(...(args as [])),
}));
vi.mock("@/lib/db/queries/photos", () => ({
  ownerPhotos: (...args: unknown[]) => ownerPhotos(...(args as [])),
  ownerPhotoQuota: (...args: unknown[]) => ownerPhotoQuota(...(args as [])),
}));

const OWNER: Viewer = { role: "owner", userId: "user_owner" };
const LISTING_ID = "33333333-3333-4333-8333-333333333333";

const LISTING: OwnerListingDetail = {
  id: LISTING_ID,
  name: "The Old Hall",
  path: "/richmond/the-old-hall",
  status: "published",
  tier: "free",
  claimStatus: "claimed",
  enquiryCount: 2,
  description: null,
  phone: null,
  website: null,
  socials: null,
  openingHours: null,
};

const PHOTOS: OwnerPhoto[] = [
  { id: "a", thumbPath: `${LISTING_ID}/a-thumb.webp`, alt: "Front", sortOrder: 0, isPrimary: true, status: "live" },
  { id: "b", thumbPath: null, alt: null, sortOrder: 1, isPrimary: false, status: "pending" },
];

async function render() {
  const { default: page } = await import("./page");
  return await page({ params: Promise.resolve({ id: LISTING_ID }) });
}

async function managerProps(tree: Awaited<ReturnType<typeof render>>) {
  const { PhotoManager } = await import("./PhotoManager");
  const el = [...elements(tree)].find((e) => e.type === PhotoManager);
  expect(el).toBeDefined();
  return el!.props as import("./PhotoManager").PhotoManagerProps;
}

beforeEach(() => {
  vi.resetModules();
  process.env.NEXT_PUBLIC_MEDIA_URL = "https://media.example.test";
  delete process.env.R2_ACCOUNT_ID;
  currentViewer.mockReset().mockResolvedValue(OWNER);
  ownerListing.mockReset().mockResolvedValue(LISTING);
  ownerPhotos.mockReset().mockResolvedValue(PHOTOS);
  ownerPhotoQuota.mockReset().mockResolvedValue({ used: 2, max: 3, tier: "free" });
});
afterEach(() => {
  process.env = { ...ENV };
});

describe("/account/listings/[id]/photos", () => {
  it("asks the owner-gated queries and mounts the manager with absolute thumbnails and the quota", async () => {
    const props = await managerProps(await render());
    expect(ownerPhotos).toHaveBeenCalledWith(DB, OWNER, LISTING_ID);
    expect(ownerPhotoQuota).toHaveBeenCalledWith(DB, OWNER, LISTING_ID);
    expect(props.listingId).toBe(LISTING_ID);
    expect(props.photos).toEqual([
      { id: "a", thumbUrl: `https://media.example.test/${LISTING_ID}/a-thumb.webp`, alt: "Front", status: "live" },
      { id: "b", thumbUrl: null, alt: "", status: "pending" },
    ]);
    expect(props.used).toBe(2);
    expect(props.max).toBe(3);
    expect(props.tierLabel).toBe("Free");
  });

  it("tells the manager uploads are unavailable when storage is not configured", async () => {
    expect((await managerProps(await render())).uploadsAvailable).toBe(false);

    process.env.R2_ACCOUNT_ID = "acct";
    process.env.R2_ACCESS_KEY_ID = "key";
    process.env.R2_SECRET_ACCESS_KEY = "secret";
    process.env.R2_BUCKET_MEDIA = "media";
    vi.resetModules();
    expect((await managerProps(await render())).uploadsAvailable).toBe(true);
  });

  it("404s for a listing this viewer does not own, without asking for its photos", async () => {
    ownerListing.mockResolvedValue(null);
    await expect(render()).rejects.toThrow(NotFound);
    expect(ownerPhotos).not.toHaveBeenCalled();
  });
});
