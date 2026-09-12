import { siteConfig } from "@/config/site.config";
import { layout, type Block, type EmailContent } from "./layout";

/**
 * The two submission notifications: one telling us there is something to
 * review, one telling the submitter we have it.
 */

export interface SubmissionEmailData {
  listingName: string;
  /**
   * Null when the submitted town could not be placed — the name is one we hold
   * in another region, or in more than one. That is also what tells the reader
   * the submission is sitting in the parked queue rather than as a pending
   * listing. A town we had never heard of is created, so it arrives named.
   */
  cityName: string | null;
  submitter: { name: string; email: string };
  /** Where an admin goes to act on it. */
  reviewUrl: string;
}

export function submissionToAdmin(data: SubmissionEmailData): EmailContent {
  const subject = `New ${siteConfig.entity.singular} submission: ${data.listingName}`;
  const blocks: Block[] = [
    { label: siteConfig.entity.Singular, value: data.listingName },
  ];
  if (data.cityName === null) {
    // An unplaceable town means no listing row was created; the payload is
    // parked and needs a decision about the town before it can become anything.
    blocks.push({ value: "The town given could not be matched to one of ours, so this is waiting in the parked queue." });
  } else {
    blocks.push({ label: "Town", value: data.cityName });
  }
  blocks.push(
    { label: "Submitted by", value: data.submitter.name },
    { label: "Email", value: data.submitter.email, href: `mailto:${data.submitter.email}` },
    { label: "Review", value: "Open the admin dashboard", href: data.reviewUrl },
  );

  return { subject, replyTo: data.submitter.email, ...layout({ subject, heading: subject, blocks }) };
}

export function submissionReceived(data: SubmissionEmailData): EmailContent {
  const subject = `We have your ${siteConfig.entity.singular} submission — ${siteConfig.name}`;
  return {
    subject,
    ...layout({
      subject,
      heading: `Thanks, ${data.submitter.name}`,
      blocks: [
        {
          value:
            `We have received your submission for ${data.listingName} and it is waiting to be ` +
            `reviewed. Nothing is live yet — someone reads every entry before it goes on the site.`,
        },
        {
          value:
            `We will email you at this address once it has been looked at. If anything needs ` +
            `changing before then, just reply and tell us.`,
        },
      ],
    }),
  };
}

/**
 * The two decision emails.
 *
 * The submitter is told what happened and, when it is good news, where to look.
 * There is no listing URL on a rejection: a page that is not published has no
 * address to give, and offering one would be an invitation to check whether it
 * has quietly gone live anyway.
 */
export interface DecisionEmailData {
  listingName: string;
  cityName: string;
  /** Absolute URL of the live page. Only used by the approval. */
  listingUrl: string;
  submitter: { name: string; email: string };
}

export function submissionApproved(data: DecisionEmailData): EmailContent {
  const subject = `${data.listingName} is now live on ${siteConfig.name}`;
  return {
    subject,
    ...layout({
      subject,
      heading: `Thanks, ${data.submitter.name} — it's live`,
      blocks: [
        {
          value:
            `${data.listingName} has been reviewed and published. It now appears on the ` +
            `${data.cityName} page and in search results on the site.`,
        },
        { label: "Your page", value: data.listingUrl, href: data.listingUrl },
        {
          value:
            `Anything that needs correcting, reply to this email and tell us. If the business ` +
            `is yours, you can claim the page to manage it and reply to enquiries yourself.`,
        },
      ],
    }),
  };
}

export function submissionRejected(
  data: DecisionEmailData & { reason: string | null },
): EmailContent {
  const subject = `About your ${siteConfig.entity.singular} submission — ${data.listingName}`;
  const blocks: Block[] = [
    {
      value:
        `We have looked at your submission for ${data.listingName} and we are not able to ` +
        `publish it as it stands.`,
    },
  ];
  // Null only where an older row carries no stored reason; the admin form
  // requires one. A blank paragraph would read as a shrug.
  if (data.reason !== null && data.reason.trim() !== "") {
    blocks.push({ label: "Why", value: data.reason.trim() });
  }
  blocks.push({
    value:
      `If that is wrong, or you can put it right, reply to this email and we will look again. ` +
      `Nothing is deleted — we keep the submission on file.`,
  });

  return { subject, ...layout({ subject, heading: subject, blocks }) };
}
