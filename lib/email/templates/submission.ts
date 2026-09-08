import { siteConfig } from "@/config/site.config";
import { layout, type Block, type EmailContent } from "./layout";

/**
 * The two submission notifications: one telling us there is something to
 * review, one telling the submitter we have it.
 */

export interface SubmissionEmailData {
  listingName: string;
  /**
   * Null when the submitted town matched nothing we hold, which is also what
   * tells the reader the submission is sitting in the parked queue rather than
   * as a pending listing.
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
    // No matching town means no listing row was created; the payload is parked
    // and needs a decision about the town before it can become anything.
    blocks.push({ value: "The town given is not one we hold, so this is waiting in the parked queue." });
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
