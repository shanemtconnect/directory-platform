import { afterEach, describe, expect, it } from "vitest";
import {
  LISTING_PHOTO_MAX_BYTES,
  deleteListingPhotoObject,
  isAllowedListingPhotoType,
  isListingPhotoKey,
  listingPhotoKey,
  listingPhotosConfigured,
  listingPhotosEnv,
  presignListingPhotoUpload,
} from "./listing-photos";

const ENV = { ...process.env };

function configure(): void {
  process.env.R2_ACCOUNT_ID = "test-account";
  process.env.R2_ACCESS_KEY_ID = "test-key";
  process.env.R2_SECRET_ACCESS_KEY = "test-secret";
  process.env.R2_BUCKET_MEDIA = "media";
}

afterEach(() => {
  process.env = { ...ENV };
});

const LISTING = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

describe("listingPhotosConfigured", () => {
  it("is true only when every R2 value and the media bucket are present", () => {
    configure();
    expect(listingPhotosConfigured()).toBe(true);
    for (const key of ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_MEDIA"]) {
      configure();
      delete process.env[key];
      expect(listingPhotosConfigured(), key).toBe(false);
    }
  });

  it("refuses to hand out a bucket name when it is not configured", () => {
    expect(() => listingPhotosEnv()).toThrow(/not configured/i);
  });
});

describe("isAllowedListingPhotoType", () => {
  it("takes the three web image types and nothing else", () => {
    expect(isAllowedListingPhotoType("image/jpeg")).toBe(true);
    expect(isAllowedListingPhotoType("image/png")).toBe(true);
    expect(isAllowedListingPhotoType("image/webp")).toBe(true);
    // A PDF is a document, not a photo; an SVG is a script that renders.
    expect(isAllowedListingPhotoType("application/pdf")).toBe(false);
    expect(isAllowedListingPhotoType("image/svg+xml")).toBe(false);
    expect(isAllowedListingPhotoType("image/gif")).toBe(false);
    expect(isAllowedListingPhotoType("")).toBe(false);
  });
});

describe("listingPhotoKey", () => {
  it("files the original under the listing with an extension matching the type", () => {
    expect(listingPhotoKey(LISTING, "image/jpeg")).toMatch(
      new RegExp(`^listings/${LISTING}/photo-[a-f0-9]{16}\\.jpg$`),
    );
    expect(listingPhotoKey(LISTING, "image/png")).toMatch(/\.png$/);
    expect(listingPhotoKey(LISTING, "image/webp")).toMatch(/\.webp$/);
  });

  it("never repeats a key, so a second upload cannot overwrite the first", () => {
    expect(listingPhotoKey(LISTING, "image/png")).not.toBe(listingPhotoKey(LISTING, "image/png"));
  });

  it("refuses a listing id that is not a uuid, and a type it does not sign for", () => {
    expect(() => listingPhotoKey("../../etc", "image/jpeg")).toThrow();
    expect(() => listingPhotoKey(LISTING, "application/pdf")).toThrow();
  });
});

describe("isListingPhotoKey", () => {
  it("accepts exactly the keys listingPhotoKey mints for that listing", () => {
    for (const type of ["image/jpeg", "image/png", "image/webp"]) {
      expect(isListingPhotoKey(LISTING, listingPhotoKey(LISTING, type)), type).toBe(true);
    }
  });

  it("refuses a key outside listings/<id>/, however it is spelled", () => {
    const suffix = "photo-0123456789abcdef.jpg";
    expect(isListingPhotoKey(LISTING, `listings/${OTHER}/${suffix}`)).toBe(false);
    expect(isListingPhotoKey(LISTING, `listings/${LISTING}/../${OTHER}/${suffix}`)).toBe(false);
    expect(isListingPhotoKey(LISTING, `listings/${LISTING}/${OTHER}/${suffix}`)).toBe(false);
    expect(isListingPhotoKey(LISTING, `claims/${LISTING}/${suffix}`)).toBe(false);
    expect(isListingPhotoKey(LISTING, `/listings/${LISTING}/${suffix}`)).toBe(false);
    expect(isListingPhotoKey(LISTING, `listings/${LISTING}/`)).toBe(false);
  });

  it("refuses a name or extension the server would never have chosen", () => {
    expect(isListingPhotoKey(LISTING, `listings/${LISTING}/photo-0123456789abcdef.svg`)).toBe(false);
    expect(isListingPhotoKey(LISTING, `listings/${LISTING}/photo-0123456789abcdef.html`)).toBe(false);
    expect(isListingPhotoKey(LISTING, `listings/${LISTING}/photo-0123456789abcdef.jpg.html`)).toBe(false);
    expect(isListingPhotoKey(LISTING, `listings/${LISTING}/photo-ZZZZZZZZZZZZZZZZ.jpg`)).toBe(false);
    expect(isListingPhotoKey(LISTING, `listings/${LISTING}/original.jpg`)).toBe(false);
    expect(isListingPhotoKey(LISTING, `listings/${LISTING}/photo-0123456789abcdef.JPG`)).toBe(false);
    expect(isListingPhotoKey(LISTING, `listings/${LISTING}/photo-0123456789abcdef.jpg\n`)).toBe(false);
  });

  it("refuses everything when the listing id is not a lower-case uuid", () => {
    expect(isListingPhotoKey("not-a-uuid", "listings/not-a-uuid/photo-0123456789abcdef.jpg")).toBe(false);
    const upper = "ABCDEFAB-ABCD-4ABC-8ABC-ABCDEFABCDEF";
    expect(isListingPhotoKey(upper, `listings/${upper}/photo-0123456789abcdef.jpg`)).toBe(false);
    const lower = upper.toLowerCase();
    expect(isListingPhotoKey(lower, `listings/${lower}/photo-0123456789abcdef.jpg`)).toBe(true);
  });
});

describe("presignListingPhotoUpload", () => {
  interface Policy {
    conditions: unknown[];
  }
  function policyOf(fields: Record<string, string>): Policy {
    return JSON.parse(Buffer.from(fields["Policy"]!, "base64").toString("utf8")) as Policy;
  }

  it("pins the exact content type and the 8 MB cap in the policy", async () => {
    configure();
    const key = listingPhotoKey(LISTING, "image/png");
    const { url, fields } = await presignListingPhotoUpload(key, "image/png");
    const policy = policyOf(fields);
    // Equality, not a prefix: `image/png` admits nothing else, not even `image/pngx`.
    expect(policy.conditions).toContainEqual(["eq", "$Content-Type", "image/png"]);
    expect(policy.conditions.some((c) => Array.isArray(c) && c[0] === "starts-with")).toBe(false);
    expect(policy.conditions).toContainEqual(["content-length-range", 1, LISTING_PHOTO_MAX_BYTES]);
    expect(LISTING_PHOTO_MAX_BYTES).toBe(8 * 1024 * 1024);
    expect(fields["key"]).toBe(key);
    expect(url).toContain("media");
  });

  it("refuses a type it does not sign for, before touching the bucket", async () => {
    configure();
    await expect(
      presignListingPhotoUpload(listingPhotoKey(LISTING, "image/png"), "image/svg+xml"),
    ).rejects.toThrow(/not allowed/);
  });

  it("rejects rather than throws when storage is not configured", async () => {
    await expect(
      presignListingPhotoUpload(`listings/${LISTING}/photo-0123456789abcdef.jpg`, "image/jpeg"),
    ).rejects.toThrow(/not configured/i);
  });
});

describe("deleteListingPhotoObject", () => {
  it("rejects rather than throws when storage is not configured, so a .catch can see it", async () => {
    let thrown: unknown = null;
    let promise: Promise<void> | null = null;
    try {
      promise = deleteListingPhotoObject(`listings/${LISTING}/photo-0123456789abcdef.jpg`);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeNull();
    await expect(promise).rejects.toThrow(/not configured/i);
  });
});
