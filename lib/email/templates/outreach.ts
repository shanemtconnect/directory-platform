import { siteConfig } from "@/config/site.config";
import { siteUrl } from "@/lib/schema/builders";
import { layout, type Block, type EmailContent } from "./layout";

/**
 * The claim-outreach message.
 *
 * A template only. Nothing in this codebase sends it: our transactional
 * provider exists to deliver enquiry notifications and password resets, and
 * pushing cold outreach through the same domain is how those stop arriving.
 * The batch exports a CSV and an outreach-capable tool does the sending.
 *
 * The content is set by what makes this legitimate rather than by what
 * converts. The recipient did not ask to hear from us, so the message has to
 * say plainly where the entry came from, that it is already live and free, and
 * how to have it taken down — in the body, not in small print. Every one of
 * those is also the honest answer to "why am I getting this?".
 */

export interface OutreachInviteData {
  businessName: string;
  cityName: string;
  /** Absolute URL of the live listing. */
  listingUrl: string;
  /** /claim/outreach/{token} — one token, one recipient. */
  magicUrl: string;
  couponCode: string;
  couponPercent: number;
  /** Where to ask for removal. */
  removalUrl: string;
}

export const OUTREACH_UNSUBSCRIBE_NOTE =
  "If you would rather not hear from us again, reply with the word STOP and we will not write again.";

export function outreachClaimInvite(data: OutreachInviteData): EmailContent {
  const e = siteConfig.entity;
  const subject = `${data.businessName} is listed on ${siteConfig.name}`;

  const blocks: Block[] = [
    {
      value:
        `We list ${e.plural} in ${data.cityName}, and ${data.businessName} is already on ` +
        `${siteConfig.name}. We built the entry from public information — nobody from your ` +
        `business asked us to, and it is free either way.`,
    },
    { label: "Your entry", value: data.listingUrl, href: data.listingUrl },
    {
      value:
        `Claiming it is free and takes about two minutes. You get to correct the details, ` +
        `add photos and opening hours, and reply to enquiries directly.`,
    },
    { label: "Claim it", value: "Open the claim link", href: data.magicUrl },
    {
      label: `${data.couponPercent}% off if you want more than the free entry`,
      value:
        `Use ${data.couponCode} at checkout. It works once, for this business only, and you ` +
        `never need it to keep the free listing.`,
    },
    {
      label: "Would rather not be listed?",
      value: "Ask us to remove the entry and we will, without argument.",
      href: data.removalUrl,
    },
    { value: OUTREACH_UNSUBSCRIBE_NOTE },
  ];

  return { subject, ...layout({ subject, heading: subject, blocks }) };
}

/** The removal page, as an absolute URL for an email. */
export function outreachRemovalUrl(listingPath: string): string {
  return siteUrl(`${listingPath}#remove`);
}
