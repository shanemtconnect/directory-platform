import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { elements, text } from "@/test/elements";
import type { PublicListingImage } from "@/lib/db/queries/listing-detail";
import { Gallery } from "./Gallery";

const ENV = { ...process.env };
beforeEach(() => {
  process.env.NEXT_PUBLIC_MEDIA_URL = "https://media.example.test";
});
afterEach(() => {
  process.env = { ...ENV };
});

const LISTING = "11111111-1111-4111-8111-111111111111";

function image(patch: Partial<PublicListingImage> = {}): PublicListingImage {
  const id = patch.id ?? "a";
  return {
    id,
    listingId: LISTING,
    storagePath: `listings/${LISTING}/photo-${id}.jpg`,
    derivatives: {
      thumb: `${LISTING}/${id}-thumb.webp`,
      card: `${LISTING}/${id}-card.webp`,
      hero: `${LISTING}/${id}-hero.webp`,
      full: `${LISTING}/${id}-full.webp`,
    },
    alt: null,
    width: 2000,
    height: 1000,
    sortOrder: 0,
    isPrimary: false,
    ...patch,
  };
}

function imgs(tree: ReturnType<typeof Gallery>) {
  return [...elements(tree)]
    .filter((el) => el.type === "img")
    .map((el) => el.props as Record<string, unknown>);
}

describe("Gallery", () => {
  it("renders nothing at all when no image is live", () => {
    expect(Gallery({ images: [image({ derivatives: null })], listingName: "The Old Mill" })).toBeNull();
    expect(Gallery({ images: [], listingName: "The Old Mill" })).toBeNull();
  });

  it("renders only live images, hero first, with width, height and lazy loading", () => {
    const tree = Gallery({
      images: [
        image({ id: "b", sortOrder: 1 }),
        image({ id: "pending", sortOrder: 2, derivatives: null }),
        image({ id: "a", sortOrder: 0, isPrimary: true, alt: "The front door" }),
      ],
      listingName: "The Old Mill",
    });
    const rendered = imgs(tree);
    expect(rendered.map((p) => p.src)).toEqual([
      `https://media.example.test/${LISTING}/a-hero.webp`,
      `https://media.example.test/${LISTING}/b-card.webp`,
    ]);
    // The hero is the likely LCP element, so it loads eagerly; the rest wait.
    expect(rendered[0]).toMatchObject({ width: 1200, height: 600, loading: "eager", alt: "The front door" });
    expect(rendered[1]).toMatchObject({ width: 600, height: 300, loading: "lazy" });
  });

  it("gives an image with no alt text the listing's name, never an empty string on a hero", () => {
    const [hero] = imgs(Gallery({ images: [image({ isPrimary: true })], listingName: "The Old Mill" }));
    expect(hero?.alt).toBe("The Old Mill");
  });

  it("says how many photos there are in words the page can be tested by", () => {
    const tree = Gallery({
      images: [image({ id: "a", isPrimary: true }), image({ id: "b", sortOrder: 1 })],
      listingName: "The Old Mill",
    });
    expect((tree?.props as Record<string, unknown>)["data-testid"]).toBe("gallery");
    expect(text(tree)).toContain("2 photos");
  });
});
