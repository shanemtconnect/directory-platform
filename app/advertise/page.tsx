import type { Metadata } from "next";
import { siteConfig } from "@/config/site.config";

export const revalidate = 3600;

export const metadata: Metadata = {
  // No site name: the root layout's title template appends it, and hardcoding
  // it here doubled up as "Advertise on X | X".
  title: "Advertise",
  description: `Reach people who are actively choosing a ${siteConfig.entity.singular} — what a listing gets you, what each tier includes, and the free badge for your own site.`,
  alternates: { canonical: "/advertise" },
};

/**
 * The sales page for the supply side.
 *
 * It deliberately makes no traffic claim. Every directory in this niche
 * publishes a monthly-visitor number nobody can check, and an owner who buys on
 * an unverifiable number churns the moment it fails to convert. What is sold
 * here is intent — who arrives and what they are trying to do — which is true
 * on day one and stays true.
 */
export default function AdvertisePage() {
  const e = siteConfig.entity;
  const { free, essential, premium } = siteConfig.tiers;

  return (
    <main>
      <h1>Advertise on {siteConfig.name}</h1>

      <p>
        {siteConfig.tagline}. That is the whole promise of this site, and it is why the people
        who arrive here are worth more to you than the same number of people from a feed. Nobody
        lands on a directory by accident. They are already choosing.
      </p>

      <h2>Who you reach</h2>
      <p>
        Someone comparing {e.plural} is at the far end of a decision. They have a date or a
        budget or a shortlist, and they are working out which name to contact first. They are not
        browsing. They came looking for exactly what you sell, in the place you sell it, and the
        next thing they do is send two or three enquiries.
      </p>
      <p>
        That is the audience. It is small compared with a social feed and it converts at a rate
        a social feed never will, because the visit begins with the question your business is the
        answer to.
      </p>

      <h2>What a listing does for you</h2>
      <ul>
        <li>
          <strong>Enquiries straight to you.</strong> Every listing, including the free one,
          carries a contact form and sends you the enquiry. We do not sell your enquiries on,
          we do not broker them, and we do not put a fee between you and the person asking.
        </li>
        <li>
          <strong>A page that ranks.</strong> Your listing sits on a site built around the
          searches your customers actually run — {e.plural} in a named place, by type. Small
          businesses rarely out-rank a directory on their own. Being on one is the cheap way in.
        </li>
        <li>
          <strong>Contact details that are never hidden.</strong> Phone, email and address are
          shown on every tier, free included. We gate richness, never reachability — a directory
          that hides your phone number to sell it back to you is selling you your own customer.
        </li>
        <li>
          <strong>Proof you can point at.</strong> A claimed listing shows you maintain it. A
          verified one shows we checked it. Both are visible to someone deciding between you and
          the next name on their list.
        </li>
        <li>
          <strong>Numbers you can act on.</strong> Views and enquiries, in your portal, so you
          can see whether this is working rather than take our word for it.
        </li>
      </ul>

      <h2>What it costs</h2>
      <p>
        Listing is free and stays free: a page, {free.maxImages} photos, an enquiry form and the
        portal to manage it, with no card required. Paid tiers buy priority in the listings, a
        fuller page and verification.
      </p>
      <ul>
        <li>
          <strong>{essential.label}</strong> — {essential.strapline}. Priority placement, your
          full description, {essential.maxImages} photos, and an ad-free page.
        </li>
        <li>
          <strong>{premium.label}</strong> — {premium.strapline}. Everything in{" "}
          {essential.label}, plus top placement, a slot on the homepage and unlimited photos.
        </li>
      </ul>
      <p>
        <a href="/pricing">
          <strong>See the full comparison and prices →</strong>
        </a>
      </p>

      <h2>Claim the listing you already have</h2>
      <p>
        If your business is already here, it was compiled from public sources and nobody is
        maintaining it. Claiming it is free, takes a few minutes, and puts you in control of what
        it says. Not listed at all?{" "}
        <a href="/add-listing">Add your {e.singular}</a>.
      </p>

      <h2>Free: the {siteConfig.name} badge</h2>
      <p>
        Every published listing gets an embeddable badge for your own website — four styles, a
        line of HTML, no charge on any tier. It shows visitors to your site that you are listed
        here, and it shows the {e.ownerNoun} on the fence that other businesses do this.
      </p>
      <p>
        <a href="/advertise/badge">
          <strong>Get your badge →</strong>
        </a>
      </p>

      <h2>What we will not do</h2>
      <p>
        We do not sell the top of a search result to whoever pays most on the day, we do not
        write or buy reviews, and paying us does not change what a review says. Priority in the
        listings is exactly that — a tie-break between businesses that already match what
        somebody searched for. Read{" "}
        <a href="/trust">how the badges and rankings work</a> before you spend anything.
      </p>

      <h2>Questions</h2>
      <p>
        Email <a href={`mailto:${siteConfig.supportEmail}`}>{siteConfig.supportEmail}</a>. A
        person answers.
      </p>
    </main>
  );
}
