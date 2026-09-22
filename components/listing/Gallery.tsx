import type { PublicListingImage } from "@/lib/db/queries/listing-detail";
import { galleryImages } from "@/lib/media/public-url";

interface Props {
  images: readonly PublicListingImage[];
  /** The alt text for a photo the owner did not describe. */
  listingName: string;
}

/**
 * The listing's photos, on the public page.
 *
 * Rendered from the worker's derivatives, never the original: a row without
 * them is an upload the worker has not sniffed, rotated or stripped of its
 * EXIF yet, and it is not shown (`galleryImages` drops it). The JSON-LD
 * `image` on the page is built from the same helper, so the markup can only
 * ever assert a photo that is on the page.
 *
 * Plain `<img>` with width and height, not `next/image`: the derivatives are
 * already the right sizes and format, and fixed boxes are what stop the page
 * shifting as they load. The hero is the likely largest element in the
 * viewport, so it loads eagerly; every other photo is lazy.
 */
export function Gallery({ images, listingName }: Props) {
  const live = galleryImages(images, listingName);
  if (live.length === 0) return null;

  const [hero, ...rest] = live;
  if (!hero) return null;

  return (
    <section aria-label="Photos" data-testid="gallery" className="mb-6">
      <figure className="m-0">
        <img
          src={hero.hero}
          alt={hero.alt}
          width={hero.heroWidth}
          height={hero.heroHeight}
          loading="eager"
          fetchPriority="high"
          decoding="async"
          className="block h-auto w-full rounded-lg"
          data-testid="gallery-hero"
        />
      </figure>
      {rest.length > 0 && (
        <ul className="card-grid mt-3" data-testid="gallery-thumbs">
          {rest.map((image) => (
            <li key={image.id}>
              <img
                src={image.card}
                alt={image.alt}
                width={image.cardWidth}
                height={image.cardHeight}
                loading="lazy"
                decoding="async"
                className="block h-auto w-full rounded-lg"
              />
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-sm text-muted">
        {live.length} {live.length === 1 ? "photo" : "photos"}
      </p>
    </section>
  );
}
