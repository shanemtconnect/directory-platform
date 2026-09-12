import { siteConfig } from "@/config/site.config";
import type { RemovalRelationship, ReportReason } from "@/lib/db/queries/trust";
import { REMOVAL_RELATIONSHIP_LABELS, REPORT_REASON_LABELS } from "@/lib/trust/labels";
import { REMOVAL_SLA_WORKING_DAYS } from "@/lib/trust/working-days";
import { layout, type Block, type EmailContent } from "./layout";

/**
 * The trust-and-safety notifications: two that tell us there is something to
 * do, one that tells a person we have their removal request.
 *
 * The acknowledgement is the one that matters most. A removal request is
 * somebody asking us to hold less of their data, and the only thing worse than
 * a slow answer is silence — they have no way of knowing the form worked, and
 * the next step from silence is a complaint to a regulator rather than a
 * second email to us.
 */

/** The deadline as a person reads it, in the site's own zone and locale. */
function dueDate(value: Date): string {
  return new Intl.DateTimeFormat(siteConfig.locale, {
    dateStyle: "long",
    timeZone: siteConfig.timezone,
  }).format(value);
}

export interface ReportEmailData {
  listingName: string;
  /** The public page, so a moderator can see the problem for themselves. */
  listingUrl: string;
  reason: ReportReason;
  detail: string | null;
  reporterEmail: string | null;
  /** Where an admin goes to act on it. */
  reviewUrl: string;
}

export function reportToAdmin(data: ReportEmailData): EmailContent {
  const subject = `Report: ${data.listingName}`;
  const blocks: Block[] = [
    { label: "Listing", value: data.listingName, href: data.listingUrl },
    { label: "Reported as", value: REPORT_REASON_LABELS[data.reason] },
  ];
  if (data.detail !== null) blocks.push({ label: "What they told us", value: data.detail });
  blocks.push(
    {
      label: "Reporter",
      // An anonymous report is still a report. Saying so plainly beats an
      // empty field an operator has to interpret.
      value: data.reporterEmail ?? "Left no email address",
      ...(data.reporterEmail === null ? {} : { href: `mailto:${data.reporterEmail}` }),
    },
    { label: "Review", value: "Open the admin dashboard", href: data.reviewUrl },
  );

  return {
    subject,
    // Only where there is somebody to reply to; an absent reply-to is better
    // than one pointing at our own mailbox.
    ...(data.reporterEmail === null ? {} : { replyTo: data.reporterEmail }),
    ...layout({ subject, heading: subject, blocks }),
  };
}

export interface RemovalEmailData {
  listingName: string;
  listingUrl: string;
  requester: { name: string; email: string };
  relationship: RemovalRelationship;
  reason: string | null;
  dueAt: Date;
  reviewUrl: string;
}

export function removalToAdmin(data: RemovalEmailData): EmailContent {
  const subject = `Removal request: ${data.listingName}`;
  const blocks: Block[] = [
    { label: "Listing", value: data.listingName, href: data.listingUrl },
    { label: "Requested by", value: data.requester.name },
    { label: "Email", value: data.requester.email, href: `mailto:${data.requester.email}` },
    { label: "Relationship", value: REMOVAL_RELATIONSHIP_LABELS[data.relationship] },
  ];
  if (data.reason !== null) blocks.push({ label: "Reason given", value: data.reason });
  blocks.push(
    // The deadline is in the notification, not only in the queue: the person
    // reading this is the person who can still meet it.
    { label: "Due by", value: dueDate(data.dueAt) },
    { label: "Action it", value: "Open the admin dashboard", href: data.reviewUrl },
  );

  return {
    subject,
    replyTo: data.requester.email,
    ...layout({ subject, heading: subject, blocks }),
  };
}

export interface RemovalDecisionEmailData {
  listingName: string;
  requesterName: string;
}

/**
 * The reply every removal page and every removal email promises: "we email
 * you when it is done." Sent only to the requester, whichever way the
 * decision goes — silence after a privacy request is what turns it into a
 * complaint, and that is true of a "no" as much as a "yes".
 */
export function removalActioned(data: RemovalDecisionEmailData): EmailContent {
  const subject = `Removed — ${data.listingName}`;
  return {
    subject,
    ...layout({
      subject,
      heading: `Done, ${data.requesterName}`,
      blocks: [
        {
          value: `We have removed ${data.listingName} from ${siteConfig.name}, as you asked.`,
        },
        {
          value:
            `We also recorded enough about it to stop a later update putting it back, so ` +
            `you do not need to ask twice.`,
        },
      ],
    }),
  };
}

export function removalRejected(data: RemovalDecisionEmailData): EmailContent {
  const subject = `Your removal request — ${siteConfig.name}`;
  return {
    subject,
    ...layout({
      subject,
      heading: `About your request, ${data.requesterName}`,
      blocks: [
        {
          value:
            `We have looked at your request to remove ${data.listingName} from ` +
            `${siteConfig.name}, and decided not to take it down.`,
        },
        {
          value: `If you think we have this wrong, reply to this email and tell us why.`,
        },
      ],
    }),
  };
}

export function removalReceived(data: RemovalEmailData): EmailContent {
  const subject = `We have your removal request — ${siteConfig.name}`;
  return {
    subject,
    ...layout({
      subject,
      heading: `Thanks, ${data.requester.name}`,
      blocks: [
        {
          value:
            `We have your request to remove ${data.listingName} from ${siteConfig.name}. ` +
            `A person reads every one of these.`,
        },
        {
          value:
            `We action removal requests within ${REMOVAL_SLA_WORKING_DAYS} working days — ` +
            `so by ${dueDate(data.dueAt)} at the latest — and we will email you when it is done.`,
        },
        {
          value:
            `When we remove a listing we also record enough to stop a later update putting ` +
            `it back. You do not need to ask twice.`,
        },
      ],
    }),
  };
}
