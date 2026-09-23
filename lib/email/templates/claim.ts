import { siteConfig } from "@/config/site.config";
import { layout, type Block, type EmailContent } from "./layout";

/**
 * The four claim notifications.
 *
 * The magic link is the one that matters: it is the whole of the proof on the
 * automatic rung, and it goes to an address on the business's own domain —
 * which is very often a shared inbox rather than the claimant's. So it says
 * plainly what is being asked for and what to do if nobody asked, because the
 * person reading it may be the one person who should stop it.
 */

interface ListingRef {
  listingName: string;
  /** Absolute URL of the public page. */
  listingUrl: string;
}

export interface ClaimMagicLinkData extends ListingRef {
  verifyUrl: string;
  expiresInMinutes: number;
}

export function claimMagicLink(data: ClaimMagicLinkData): EmailContent {
  const subject = `Confirm your ${siteConfig.entity.singular} listing: ${data.listingName}`;
  const blocks: Block[] = [
    {
      value:
        `Somebody asked to manage the ${siteConfig.entity.singular} listing for ` +
        `${data.listingName} on ${siteConfig.name}, using this email address.`,
    },
    { label: "Confirm the claim", value: "Open this link and press Confirm", href: data.verifyUrl },
    {
      value:
        `The link works once and expires in ${data.expiresInMinutes} minutes. ` +
        "Opening it only shows you what is being asked for — nothing changes " +
        "until you press Confirm.",
    },
    { label: siteConfig.entity.Singular, value: data.listingName, href: data.listingUrl },
    {
      value:
        "If you did not ask for this, ignore this email. Nobody takes the listing " +
        "unless somebody opens the link and confirms.",
    },
  ];
  return { subject, ...layout({ subject, heading: "Confirm your claim", blocks }) };
}

export interface ClaimApprovedData extends ListingRef {
  /** Where the new owner manages the listing. */
  dashboardUrl: string;
}

export function claimApproved(data: ClaimApprovedData): EmailContent {
  const subject = `Your ${siteConfig.entity.singular} listing is yours: ${data.listingName}`;
  return {
    subject,
    ...layout({
      subject,
      heading: "Claim approved",
      blocks: [
        {
          value:
            `You can now edit ${data.listingName} and see the enquiries it receives.`,
        },
        { label: "Manage your listing", value: "Open your dashboard", href: data.dashboardUrl },
        { label: siteConfig.entity.Singular, value: data.listingName, href: data.listingUrl },
      ],
    }),
  };
}

export interface ClaimRejectedData extends ListingRef {
  reason: string;
}

export function claimRejected(data: ClaimRejectedData): EmailContent {
  const subject = `About your claim on ${data.listingName}`;
  return {
    subject,
    ...layout({
      subject,
      heading: "We could not approve this claim",
      blocks: [
        {
          value:
            `We have looked at your request to manage the ${siteConfig.entity.singular} ` +
            `listing for ${data.listingName} and could not approve it.`,
        },
        { label: "Why", value: data.reason },
        {
          value:
            "You are welcome to try again with clearer evidence, or reply to this " +
            "email and a person will pick it up.",
        },
        { label: siteConfig.entity.Singular, value: data.listingName, href: data.listingUrl },
      ],
    }),
  };
}

export interface ClaimToAdminData extends ListingRef {
  claimantName: string | null;
  claimantEmail: string | null;
  reviewUrl: string;
}

/** A document claim cannot be decided automatically, so somebody is told. */
export function claimToAdmin(data: ClaimToAdminData): EmailContent {
  const subject = `${siteConfig.entity.Singular} claim to review: ${data.listingName}`;
  const blocks: Block[] = [
    { label: siteConfig.entity.Singular, value: data.listingName, href: data.listingUrl },
  ];
  // Both are optional on the form, and an empty "Claimant:" line reads as a fault.
  if (data.claimantName !== null && data.claimantName.trim() !== "") {
    blocks.push({ label: "Claimant", value: data.claimantName });
  }
  if (data.claimantEmail !== null && data.claimantEmail.trim() !== "") {
    blocks.push({ label: "Email", value: data.claimantEmail, href: `mailto:${data.claimantEmail}` });
  }
  blocks.push({ label: "Review", value: "Open the claim", href: data.reviewUrl });

  return {
    subject,
    ...(data.claimantEmail === null || data.claimantEmail.trim() === ""
      ? {}
      : { replyTo: data.claimantEmail }),
    ...layout({ subject, heading: subject, blocks }),
  };
}
