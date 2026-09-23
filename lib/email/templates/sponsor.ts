import { siteConfig } from "@/config/site.config";
import { layout, type Block, type EmailContent } from "./layout";

/**
 * Sponsor rail mail (Task 43): the admin hears a campaign was submitted; the
 * advertiser hears it was approved or turned down. Every value goes through
 * the layout's escaping — the copy was typed by an advertiser.
 */
export interface SponsorEmailData {
  name: string;
  title: string;
  blurb: string;
  targetUrl: string;
  advertiserEmail: string | null;
  reviewUrl: string;
  manageUrl: string;
}

function copyBlocks(data: SponsorEmailData): Block[] {
  return [
    { label: "Advertiser", value: data.name },
    { label: "Headline", value: data.title },
    { label: "Blurb", value: data.blurb },
    { label: "Links to", value: data.targetUrl, href: data.targetUrl },
  ];
}

export function sponsorToAdmin(data: SponsorEmailData): EmailContent {
  const subject = `Sponsor campaign to review: ${data.name}`;
  const blocks: Block[] = [
    ...copyBlocks(data),
    {
      label: "From",
      value: data.advertiserEmail ?? "No account email",
      ...(data.advertiserEmail === null ? {} : { href: `mailto:${data.advertiserEmail}` }),
    },
    { label: "Review", value: "Open the sponsor queue", href: data.reviewUrl },
  ];
  return {
    subject,
    ...(data.advertiserEmail === null ? {} : { replyTo: data.advertiserEmail }),
    ...layout({ subject, heading: subject, blocks }),
  };
}

export function sponsorApproved(data: SponsorEmailData): EmailContent {
  const subject = `Your sponsor campaign is live on ${siteConfig.name}`;
  const blocks: Block[] = [
    {
      value:
        `Thanks — "${data.title}" has been approved and is now showing in the sponsor ` +
        `rails on ${siteConfig.name}. It rotates with the other live campaigns; the ` +
        `impressions and clicks it earns are in your account.`,
    },
    ...copyBlocks(data),
    { label: "Manage it", value: "Your sponsor campaigns", href: data.manageUrl },
  ];
  return { subject, ...layout({ subject, heading: "Your campaign is live", blocks }) };
}

export function sponsorRejected(data: SponsorEmailData & { reason: string }): EmailContent {
  const subject = `We could not run your sponsor campaign on ${siteConfig.name}`;
  const blocks: Block[] = [
    {
      value:
        `We looked at "${data.title}" and are not able to run it as submitted. ` +
        `If a subscription was started it will not be charged for a slot we did not show.`,
    },
    { label: "Why", value: data.reason },
    ...copyBlocks(data),
    { label: "Edit and resubmit", value: "Your sponsor campaigns", href: data.manageUrl },
  ];
  return { subject, ...layout({ subject, heading: "We could not run this campaign", blocks }) };
}
