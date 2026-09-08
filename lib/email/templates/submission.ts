import { siteConfig } from "@/config/site.config";
import { layout, type Block, type EmailContent } from "./layout";

/**
 * The two submission notifications: one telling us there is something to
 * review, one telling the submitter we have it.
 */

export interface SubmissionEmailData {
  listingName: string;
  /** Null when the submitted town matched nothing we hold and was parked. */
  cityName: string | null;
  submitter: { name: string; email: string };
  /** Null for a parked submission — there is no page to link to yet. */
  reviewUrl: string | null;
}

export function submissionToAdmin(data: SubmissionEmailData): EmailContent {
  const subject = `New ${siteConfig.entity.singular} submission: ${data.listingName}`;
  const blocks: Block[] = [
    { label: siteConfig.entity.Singular, value: data.listingName },
  ];
  if (data.cityName !== null) blocks.push({ label: "Town", value: data.cityName });
  blocks.push(
    { label: "Submitted by", value: data.submitter.name },
    { label: "Email", value: data.submitter.email, href: `mailto:${data.submitter.email}` },
  );
  if (data.reviewUrl !== null) {
    blocks.push({ label: "Review", value: "Open the submission", href: data.reviewUrl });
  } else {
    // Parked submissions have no listing row, so there is nothing to link.
    blocks.push({ value: "The town was not one we hold, so this is waiting in the parked queue." });
  }

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
