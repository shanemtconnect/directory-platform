import { siteConfig } from "@/config/site.config";
import { awardBadgeStyle, BADGE_STYLES, type BadgeStyle, type StaticBadgeStyle } from "@/lib/badge/svg";
import { badgeKit, type SnippetInput } from "@/lib/badge/snippets";
import { BadgePreview } from "./BadgePreview";
import { SnippetBlock } from "./SnippetBlock";

const BLURB: Record<StaticBadgeStyle, string> = {
  dark: "The default. Sits well on a light page and on a photo.",
  light: "For dark headers and footers, or anywhere the dark badge disappears.",
  compact: "One line, 40px tall. Made for a footer strip beside other marks.",
  rating: "Carries the star rating as well. Only worth using once ratings exist.",
};

/**
 * The four styles, each with a live preview and the exact code to paste.
 *
 * Every preview is rendered from the same function the image endpoint uses, so
 * what is shown here cannot drift from what gets served.
 */
export function BadgeGallery({
  base, verified, ratingAvg, ratingCount, awardYears = [],
}: {
  base: Omit<SnippetInput, "style">;
  verified: boolean;
  ratingAvg?: string | number | null;
  ratingCount?: number | null;
  /**
   * The years this listing won an award (Task 50), newest first — read from
   * the `awards` table by the page, never guessed. Each adds an `award-<year>`
   * style after the four everyone gets. Empty for everyone else.
   */
  awardYears?: readonly number[];
}) {
  const styles: { style: BadgeStyle; title: string; blurb: string }[] = [
    ...BADGE_STYLES.map((style) => ({ style, title: style, blurb: BLURB[style] })),
    ...awardYears.map((year) => ({
      style: awardBadgeStyle(year),
      title: `Winner ${year}`,
      blurb: `Your ${year} award, computed from published reviews. It only ever renders for a listing that won.`,
    })),
  ];
  return (
    <div>
      {styles.map(({ style, title, blurb }) => {
        const kit = badgeKit({ ...base, style });
        return (
          <section key={style} className="my-8 border-t border-neutral-200 pt-6" data-badge-style={style}>
            <h3 className="capitalize">{title}</h3>
            <p className="text-sm text-neutral-600">{blurb}</p>

            <div
              className={
                style === "light"
                  ? "my-3 inline-block rounded bg-neutral-900 p-4"
                  : "my-3 inline-block rounded bg-neutral-100 p-4"
              }
            >
              <BadgePreview
                input={{
                  siteName: siteConfig.name,
                  listingName: base.listingName,
                  style,
                  verified,
                  ratingAvg,
                  ratingCount,
                }}
              />
            </div>

            <p className="text-sm text-neutral-600">
              {kit.dimensions.width} × {kit.dimensions.height} px · SVG, so it stays sharp on any
              screen.
            </p>

            <SnippetBlock
              heading="Paste this into your page"
              note="The badge links straight to your listing. Nothing counts the clicks."
              code={kit.embed}
              copyLabel="Copy embed"
            />

            <details className="mt-2">
              <summary className="cursor-pointer text-sm text-neutral-600">
                Or use the version that counts clicks
              </summary>
              <p className="mt-2 text-sm text-neutral-600">
                This one sends the visitor through us first, so we can show you how many people
                clicked — but the link is marked <code>nofollow</code>, because a link routed
                through a redirect is not a recommendation and we are not going to pretend
                otherwise. The plain badge above is the better link; this one is the better
                number. Pick whichever you actually want.
              </p>
              <SnippetBlock
                code={kit.trackedEmbed}
                copyLabel="Copy tracked embed"
              />
            </details>
          </section>
        );
      })}

      <section className="my-8 border-t border-neutral-200 pt-6">
        <h3>Text link instead</h3>
        <p>
          If an image does not suit the page, use a plain link. Three wordings are offered on
          purpose: if every site that links to us uses identical anchor text, the pattern looks
          manufactured — to readers as much as to search engines. Pick whichever reads naturally
          in your sentence.
        </p>
        {badgeKit({ ...base, style: "dark" }).anchors.map((a) => (
          <SnippetBlock
            key={a.key}
            heading={a.label}
            note={`Reads as: ${a.text}`}
            code={a.html}
            copyLabel="Copy link"
          />
        ))}
      </section>
    </div>
  );
}
