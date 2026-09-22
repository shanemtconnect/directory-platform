import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Viewer } from "@/lib/db/viewer";
import type {
  AltResult, CreatePhotoResult, DeletePhotoResult, PhotoQuota, ReorderResult,
} from "@/lib/db/queries/photos";

/**
 * The photo actions, with the database and the bucket mocked out.
 *
 * What each write does is tested against a real transaction in
 * lib/db/queries/photos.test.ts. What is only testable here is the seam: the
 * presign step refuses before touching the bucket when storage is off or the
 * cap is reached, the confirm step refuses a key outside the listing's own
 * prefix before the query sees it, every change busts the listing paths and
 * the owner's own photos page, and a delete removes the orphaned objects only
 * AFTER the transaction has returned.
 */

const currentViewer = vi.fn<() => Promise<Viewer>>();
const ownerPhotoQuota = vi.fn<(...a: unknown[]) => Promise<PhotoQuota | null>>();
const createOwnerPhoto = vi.fn<(...a: unknown[]) => Promise<CreatePhotoResult>>();
const deleteOwnerPhoto = vi.fn<(...a: unknown[]) => Promise<DeletePhotoResult>>();
const reorderOwnerPhotos = vi.fn<(...a: unknown[]) => Promise<ReorderResult>>();
const setOwnerPhotoAlt = vi.fn<(...a: unknown[]) => Promise<AltResult>>();
const revalidateListingPaths = vi.fn<(paths: readonly string[]) => void>();
const revalidatePath = vi.fn<(path: string) => void>();
const presignListingPhotoUpload = vi.fn<(key: string, type: string) => Promise<{ url: string; fields: Record<string, string> }>>();
const deleteListingPhotoObject = vi.fn<(key: string) => Promise<void>>();
const listingPhotosConfigured = vi.fn<() => boolean>();

const HANDLE = { marker: "the transaction" };
const transaction = vi.fn(
  async <T,>(fn: (tx: unknown) => Promise<T>): Promise<T> => await fn(HANDLE),
);

vi.mock("next/headers", () => ({
  headers: () => Promise.resolve(new Headers({ "x-forwarded-for": "203.0.113.9" })),
}));
vi.mock("next/cache", () => ({ revalidatePath: (path: string) => revalidatePath(path) }));
vi.mock("@/lib/db/client", () => ({ db: { transaction: (fn: never) => transaction(fn) } }));
vi.mock("@/lib/auth/viewer", () => ({ currentViewer: () => currentViewer() }));
vi.mock("@/lib/db/queries/photos", () => ({
  ownerPhotoQuota: (...args: unknown[]) => ownerPhotoQuota(...args),
  createOwnerPhoto: (...args: unknown[]) => createOwnerPhoto(...args),
  deleteOwnerPhoto: (...args: unknown[]) => deleteOwnerPhoto(...args),
  reorderOwnerPhotos: (...args: unknown[]) => reorderOwnerPhotos(...args),
  setOwnerPhotoAlt: (...args: unknown[]) => setOwnerPhotoAlt(...args),
}));
vi.mock("@/lib/revalidate/listing", () => ({
  revalidateListingPaths: (paths: readonly string[]) => revalidateListingPaths(paths),
}));
vi.mock("@/lib/media/listing-photos", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/media/listing-photos")>();
  return {
    ...real,
    listingPhotosConfigured: () => listingPhotosConfigured(),
    presignListingPhotoUpload: (key: string, type: string) => presignListingPhotoUpload(key, type),
    deleteListingPhotoObject: (key: string) => deleteListingPhotoObject(key),
  };
});

const OWNER: Viewer = { role: "owner", userId: "user_owner" };
const LISTING_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";
const PHOTO_ID = "33333333-3333-4333-8333-333333333333";
const PATHS = ["/leeds/the-old-mill", "/leeds/the-old-mill/reviews", "/leeds"];
const KEY = `listings/${LISTING_ID}/photo-0123456789abcdef.jpg`;

beforeEach(() => {
  vi.resetModules();
  currentViewer.mockReset().mockResolvedValue(OWNER);
  ownerPhotoQuota.mockReset().mockResolvedValue({ used: 1, max: 3, tier: "free" });
  createOwnerPhoto.mockReset();
  deleteOwnerPhoto.mockReset();
  reorderOwnerPhotos.mockReset();
  setOwnerPhotoAlt.mockReset();
  revalidateListingPaths.mockReset();
  revalidatePath.mockReset();
  presignListingPhotoUpload.mockReset().mockResolvedValue({ url: "https://r2.test/media", fields: { key: "k" } });
  deleteListingPhotoObject.mockReset().mockResolvedValue(undefined);
  listingPhotosConfigured.mockReset().mockReturnValue(true);
  transaction.mockClear();
});

describe("preparePhotoUpload", () => {
  it("signs a key under the listing's own prefix for an allowed type", async () => {
    const { preparePhotoUpload } = await import("./photos");
    const result = await preparePhotoUpload({ listingId: LISTING_ID, contentType: "image/jpeg" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.key).toMatch(new RegExp(`^listings/${LISTING_ID}/photo-[a-f0-9]{16}\\.jpg$`));
    expect(presignListingPhotoUpload).toHaveBeenCalledWith(result.key, "image/jpeg");
    expect(result.url).toBe("https://r2.test/media");
  });

  it("says so when storage is not configured, before anything else", async () => {
    listingPhotosConfigured.mockReturnValue(false);
    const { preparePhotoUpload } = await import("./photos");
    const result = await preparePhotoUpload({ listingId: LISTING_ID, contentType: "image/jpeg" });
    expect(result).toEqual({ ok: false, message: expect.stringMatching(/not available/i) });
    expect(ownerPhotoQuota).not.toHaveBeenCalled();
    expect(presignListingPhotoUpload).not.toHaveBeenCalled();
  });

  it("refuses a type it will not sign for, and an anonymous viewer", async () => {
    const { preparePhotoUpload } = await import("./photos");
    expect(await preparePhotoUpload({ listingId: LISTING_ID, contentType: "image/svg+xml" }))
      .toEqual({ ok: false, message: expect.stringMatching(/JPEG, PNG or WebP/) });
    currentViewer.mockResolvedValue({ role: "public" });
    expect(await preparePhotoUpload({ listingId: LISTING_ID, contentType: "image/jpeg" }))
      .toEqual({ ok: false, message: expect.stringMatching(/sign in/i) });
    expect(presignListingPhotoUpload).not.toHaveBeenCalled();
  });

  it("refuses at the tier's cap, and for a listing the viewer does not own", async () => {
    const { preparePhotoUpload } = await import("./photos");
    ownerPhotoQuota.mockResolvedValue({ used: 3, max: 3, tier: "free" });
    expect(await preparePhotoUpload({ listingId: LISTING_ID, contentType: "image/png" }))
      .toEqual({ ok: false, message: expect.stringMatching(/3 photos/) });
    ownerPhotoQuota.mockResolvedValue(null);
    expect(await preparePhotoUpload({ listingId: OTHER_ID, contentType: "image/png" }))
      .toEqual({ ok: false, message: expect.stringMatching(/could not be found/) });
    expect(presignListingPhotoUpload).not.toHaveBeenCalled();
  });

  it("never leaks the bucket when signing fails", async () => {
    presignListingPhotoUpload.mockRejectedValue(new Error("bucket media in account test-account"));
    const { preparePhotoUpload } = await import("./photos");
    const result = await preparePhotoUpload({ listingId: LISTING_ID, contentType: "image/png" });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("test-account");
  });
});

describe("confirmPhotoUpload", () => {
  it("records the row with the ip and busts the listing paths and the photos page", async () => {
    createOwnerPhoto.mockResolvedValue({ outcome: "created", id: PHOTO_ID, paths: PATHS });
    const { confirmPhotoUpload } = await import("./photos");
    expect(await confirmPhotoUpload({ listingId: LISTING_ID, key: KEY })).toEqual({ ok: true });
    expect(createOwnerPhoto).toHaveBeenCalledWith(
      HANDLE, OWNER, { listingId: LISTING_ID, storagePath: KEY, ip: "203.0.113.9" },
    );
    expect(revalidateListingPaths).toHaveBeenCalledWith(PATHS);
    expect(revalidatePath).toHaveBeenCalledWith(`/account/listings/${LISTING_ID}/photos`);
  });

  it("refuses a key outside listings/<id>/ before the query sees it", async () => {
    const { confirmPhotoUpload } = await import("./photos");
    const result = await confirmPhotoUpload({
      listingId: LISTING_ID, key: `listings/${OTHER_ID}/photo-0123456789abcdef.jpg`,
    });
    expect(result.ok).toBe(false);
    expect(createOwnerPhoto).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it("reports the cap and a stranger's listing without busting anything", async () => {
    const { confirmPhotoUpload } = await import("./photos");
    createOwnerPhoto.mockResolvedValue({ outcome: "limit", max: 3 });
    expect(await confirmPhotoUpload({ listingId: LISTING_ID, key: KEY }))
      .toEqual({ ok: false, message: expect.stringMatching(/3 photos/) });
    createOwnerPhoto.mockResolvedValue({ outcome: "not-found" });
    expect(await confirmPhotoUpload({ listingId: LISTING_ID, key: KEY }))
      .toEqual({ ok: false, message: expect.stringMatching(/could not be found/) });
    expect(revalidateListingPaths).not.toHaveBeenCalled();
  });
});

describe("deletePhoto", () => {
  it("removes the orphaned objects after the transaction, then busts the paths", async () => {
    const order: string[] = [];
    transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      order.push("transaction");
      return fn(HANDLE);
    });
    deleteListingPhotoObject.mockImplementation(async (key) => { order.push(`delete ${key}`); });
    deleteOwnerPhoto.mockResolvedValue({ outcome: "deleted", keys: [KEY, "a/thumb.webp"], paths: PATHS });

    const { deletePhoto } = await import("./photos");
    expect(await deletePhoto({ listingId: LISTING_ID, photoId: PHOTO_ID })).toEqual({ ok: true });
    expect(deleteOwnerPhoto).toHaveBeenCalledWith(HANDLE, OWNER, PHOTO_ID, "203.0.113.9");
    expect(order).toEqual(["transaction", `delete ${KEY}`, "delete a/thumb.webp"]);
    expect(revalidateListingPaths).toHaveBeenCalledWith(PATHS);
    expect(revalidatePath).toHaveBeenCalledWith(`/account/listings/${LISTING_ID}/photos`);
  });

  it("still succeeds when the bucket refuses: the row is the truth", async () => {
    deleteOwnerPhoto.mockResolvedValue({ outcome: "deleted", keys: [KEY], paths: PATHS });
    deleteListingPhotoObject.mockRejectedValue(new Error("no such bucket"));
    const { deletePhoto } = await import("./photos");
    expect(await deletePhoto({ listingId: LISTING_ID, photoId: PHOTO_ID })).toEqual({ ok: true });
    expect(revalidateListingPaths).toHaveBeenCalledWith(PATHS);
  });

  it("is a not-found for a stranger's photo, with nothing deleted from the bucket", async () => {
    deleteOwnerPhoto.mockResolvedValue({ outcome: "not-found" });
    const { deletePhoto } = await import("./photos");
    const result = await deletePhoto({ listingId: LISTING_ID, photoId: PHOTO_ID });
    expect(result.ok).toBe(false);
    expect(deleteListingPhotoObject).not.toHaveBeenCalled();
  });
});

describe("reorderPhotos and savePhotoAlt", () => {
  it("hand the whole order to the query and bust the paths", async () => {
    reorderOwnerPhotos.mockResolvedValue({ outcome: "saved", paths: PATHS });
    const { reorderPhotos } = await import("./photos");
    expect(await reorderPhotos({ listingId: LISTING_ID, orderedIds: [PHOTO_ID, OTHER_ID] })).toEqual({ ok: true });
    expect(reorderOwnerPhotos).toHaveBeenCalledWith(HANDLE, OWNER, LISTING_ID, [PHOTO_ID, OTHER_ID], "203.0.113.9");
    expect(revalidateListingPaths).toHaveBeenCalledWith(PATHS);
  });

  it("reports a stale order as a refusal rather than a renumber", async () => {
    reorderOwnerPhotos.mockResolvedValue({ outcome: "mismatch" });
    const { reorderPhotos } = await import("./photos");
    const result = await reorderPhotos({ listingId: LISTING_ID, orderedIds: [PHOTO_ID] });
    expect(result).toEqual({ ok: false, message: expect.stringMatching(/reload/i) });
    expect(revalidateListingPaths).not.toHaveBeenCalled();
  });

  it("save alt text, capped, and bust the paths", async () => {
    setOwnerPhotoAlt.mockResolvedValue({ outcome: "saved", paths: PATHS });
    const { savePhotoAlt } = await import("./photos");
    expect(await savePhotoAlt({ listingId: LISTING_ID, photoId: PHOTO_ID, alt: "The front door" })).toEqual({ ok: true });
    expect(setOwnerPhotoAlt).toHaveBeenCalledWith(HANDLE, OWNER, PHOTO_ID, "The front door", "203.0.113.9");
    expect(revalidateListingPaths).toHaveBeenCalledWith(PATHS);

    const long = await savePhotoAlt({ listingId: LISTING_ID, photoId: PHOTO_ID, alt: "x".repeat(300) });
    expect(long.ok).toBe(false);
  });
});
