import type { Metadata } from "next";
import { siteConfig } from "@/config/site.config";
import { BadgeGallery } from "@/components/advertise/BadgeGallery";
import type { SnippetInput } from "@/lib/badge/snippets";

export const revalidate = 3600;

export const metadata: Metadata = {
  // No site name: the root layout's title template appends it, and hardcoding
  // it here doubled up as "Get your X badge | X".
  title: "Get your badge",
  description: `Four free badge styles for your own website. Pick one, copy a line of HTML, done.`,
  alternates: { canonical: "/advertise/badge" },
};

/**
 * The worked example. This page is static (ISR, hourly) and takes no request
 * input — reading `searchParams` makes a route dynamic in Next 16, and the
 * `revalidate` above was a dead export for as long as it did. The owner's own
 * snippet, and the form that asks where they put it, live at
 * /advertise/badge/mine behind a session.
 */
function example(): { base: Omit<SnippetInput, "style"> } {
  const e = siteConfig.entity;
  return {
    base: {
      listingId: "00000000-0000-4000-8000-000000000000",
      listingName: `Your ${e.Singular}`,
      listingPath: `/your-town/your-${e.singular}`,
      cityName: "Your town",
      categoryName: e.Singular,
    },
  };
}

export default async function BadgePage() {
  const e = siteConfig.entity;
  const r = example();

  return (
    <main>
      <h1>Get your {siteConfig.name} badge</h1>

      <p>
        Free on every tier, including the free one. Pick a style, copy the line of HTML, and paste
        it wherever it fits on your own site — a footer, an about page, alongside whatever other
        marks you carry.
      </p>

      <p>
        <strong>This is a worked example.</strong> If you own a listing here,{" "}
        <a href="/advertise/badge/mine" data-testid="my-badge-link">
          sign in for your own code
        </a>
        , which points at your page instead of a placeholder — and tell us where you put it, so
        we can find the link.
      </p>

      <h2>The four styles</h2>
      <p>
        Each style comes with two versions of the same code: the plain one, whose badge links
        straight to your listing, and a tracked one that routes the click through us so the
        count is visible to you — at the cost of a <code>nofollow</code> on the link. The plain
        one is the default because the link is the point.
      </p>
      <BadgeGallery base={r.base} verified={true} ratingAvg="4.8" ratingCount={27} />

      <h2>What the badge shows</h2>
      <ul>
        <li>
          The {siteConfig.name} name and your {e.singular} name, drawn as an SVG, so it stays
          sharp on any screen and weighs almost nothing.
        </li>
        <li>
          A <strong>Verified</strong> mark, but only while your listing actually is verified. It
          is drawn from your live claim status, so it appears when you pass verification and it
          disappears if that lapses. It is not something the code you paste can turn on.
        </li>
        <li>
          On the rating style, your current rating and how many ratings it is based on. If you
          have none yet, it says so rather than inventing a score.
        </li>
      </ul>

      <h2>Rules, such as they are</h2>
      <ul>
        <li>
          Link the badge to your own listing and leave the link in place. An image with the link
          stripped out is not a badge, it is a picture.
        </li>
        <li>
          Do not edit the image or re-host it. Loading it from us is what keeps it current when
          your details change.
        </li>
        <li>
          The badge says you are listed here. It does not say we endorse your work, and you
          should not present it as though it does — see{" "}
          <a href="/trust">what our badges mean</a>.
        </li>
        <li>
          Unpublish your listing and the badge stops rendering. Nothing to remove at your end.
        </li>
      </ul>

      <h2>Why bother</h2>
      <p>
        Two reasons, and only one of them is about us. A visitor already on your site is
        reassured by a third-party listing they can click through and check. And the link is a
        genuine one between two real businesses, which is the only kind worth having.
      </p>

      <p>
        Not listed yet? <a href="/add-listing">Add your {e.singular}</a>, or read{" "}
        <a href="/advertise">what a listing gets you</a> first.
      </p>
    </main>
  );
}
