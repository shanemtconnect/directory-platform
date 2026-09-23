import { afterEach, describe, expect, it } from "vitest";
import { galleryImages, mediaUrl } from "./public-url";
import { DERIVATIVE_SIZES } from "./derivatives";

const ENV = { ...process.env };
afterEach(() => {
  process.env = { ...ENV };
});

const LISTING = "11111111-1111-4111-8111-111111111111";

function image(patch: Partial<Parameters<typeof galleryImages>[0][number]> = {}) {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    listingId: LISTING,
    storagePath: `listings/${LISTING}/photo-0123456789abcdef.jpg`,
    derivatives: {
      thumb: `${LISTING}/a-thumb.webp`,
      card: `${LISTING}/a-card.webp`,
      hero: `${LISTING}/a-hero.webp`,
      full: `${LISTING}/a-full.webp`,
    },
    alt: "The front of the building",
    width: 2000,
    height: 1500,
    sortOrder: 0,
    isPrimary: true,
    ...patch,
  };
}

describe("mediaUrl", () => {
  it("joins the CDN origin and the key with exactly one slash", () => {
    process.env.NEXT_PUBLIC_MEDIA_URL = "https://media.example.test/";
    expect(mediaUrl("/a/b.webp")).toBe("https://media.example.test/a/b.webp");
    expect(mediaUrl("a/b.webp")).toBe("https://media.example.test/a/b.webp");
  });

  it("is null without a media origin — nothing resolves against the site's own domain", () => {
    delete process.env.NEXT_PUBLIC_MEDIA_URL;
    expect(mediaUrl("a/b.webp")).toBeNull();
  });
});

describe("galleryImages", () => {
  it("renders only images the worker has finished, hero first", () => {
    process.env.NEXT_PUBLIC_MEDIA_URL = "https://media.example.test";
    const out = galleryImages([
      image({ id: "b", sortOrder: 1, isPrimary: false, derivatives: null }),
      image({ id: "c", sortOrder: 2, isPrimary: false }),
      image({ id: "a", sortOrder: 0, isPrimary: true }),
    ]);
    expect(out.map((i) => i.id)).toEqual(["a", "c"]);
    expect(out[0]?.hero).toBe(`https://media.example.test/${LISTING}/a-hero.webp`);
    expect(out[0]?.full).toBe(`https://media.example.test/${LISTING}/a-full.webp`);
  });

  it("ignores a derivatives blob missing the sizes the page needs", () => {
    process.env.NEXT_PUBLIC_MEDIA_URL = "https://media.example.test";
    expect(galleryImages([image({ derivatives: { thumb: "x" } })])).toEqual([]);
    expect(galleryImages([image({ derivatives: "nonsense" })])).toEqual([]);
  });

  it("scales the stored dimensions to the hero and card widths", () => {
    process.env.NEXT_PUBLIC_MEDIA_URL = "https://media.example.test";
    const [out] = galleryImages([image({ width: 2000, height: 1500 })]);
    expect(out?.heroWidth).toBe(DERIVATIVE_SIZES.hero);
    expect(out?.heroHeight).toBe(900);
    expect(out?.cardWidth).toBe(DERIVATIVE_SIZES.card);
    expect(out?.cardHeight).toBe(450);
  });

  it("never enlarges: a small original keeps its own size", () => {
    process.env.NEXT_PUBLIC_MEDIA_URL = "https://media.example.test";
    const [out] = galleryImages([image({ width: 400, height: 300 })]);
    expect(out?.heroWidth).toBe(400);
    expect(out?.heroHeight).toBe(300);
  });

  it("falls back to the derivative width with no stored size, so the attributes are always set", () => {
    process.env.NEXT_PUBLIC_MEDIA_URL = "https://media.example.test";
    const [out] = galleryImages([image({ width: null, height: null })]);
    expect(out?.heroWidth).toBe(DERIVATIVE_SIZES.hero);
    expect(out?.heroHeight).toBe(Math.round(DERIVATIVE_SIZES.hero * 3 / 4));
  });

  it("is empty without a media origin, so a page never renders a broken image", () => {
    delete process.env.NEXT_PUBLIC_MEDIA_URL;
    expect(galleryImages([image()])).toEqual([]);
  });

  it("uses a plain description when the owner wrote no alt text", () => {
    process.env.NEXT_PUBLIC_MEDIA_URL = "https://media.example.test";
    const [out] = galleryImages([image({ alt: null })], "The Old Mill");
    expect(out?.alt).toBe("The Old Mill");
  });
});
