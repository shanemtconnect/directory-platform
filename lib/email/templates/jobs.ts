import { siteConfig } from "@/config/site.config";
import { layout, type Block, type EmailContent } from "./layout";

/**
 * The jobs board's four emails (Task 49).
 *
 * One to us when a post is waiting, three to the poster: approved, turned
 * down, closing soon. Every date is written out — "closes on 22 October" —
 * because a reminder that says "in 7 days" read a week late is wrong.
 */

function formatDate(value: Date): string {
  return new Intl.DateTimeFormat(siteConfig.locale, {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: siteConfig.timezone,
  }).format(value);
}

export interface JobSubmittedData {
  title: string;
  companyName: string | null;
  cityName: string | null;
  posterName: string | null;
  posterEmail: string | null;
  /** True when the poster paid; false for a Verified owner's free post. */
  paid: boolean;
  reviewUrl: string;
}

export function jobSubmittedToAdmin(data: JobSubmittedData): EmailContent {
  const subject = `New job post to review: ${data.title}`;
  const blocks: Block[] = [{ label: "Job", value: data.title }];
  if (data.companyName) blocks.push({ label: "Hiring", value: data.companyName });
  if (data.cityName) blocks.push({ label: "Town", value: data.cityName });
  blocks.push({
    value: data.paid
      ? "The poster has paid for this post. It goes live when you approve it."
      : `Posted free by the owner of a Verified ${siteConfig.entity.singular}. It goes live when you approve it.`,
  });
  if (data.posterName) blocks.push({ label: "Posted by", value: data.posterName });
  if (data.posterEmail) blocks.push({ label: "Email", value: data.posterEmail, href: `mailto:${data.posterEmail}` });
  blocks.push({ label: "Review", value: "Open the jobs queue", href: data.reviewUrl });
  return {
    subject,
    ...(data.posterEmail ? { replyTo: data.posterEmail } : {}),
    ...layout({ subject, heading: subject, blocks }),
  };
}

export interface JobDecidedData {
  title: string;
  posterName: string | null;
  jobUrl: string;
  /** Set on approval: when the post closes. */
  closesOn: Date | null;
  /** Set on rejection: the reason the admin gave. */
  reason: string | null;
}

export function jobApproved(data: JobDecidedData): EmailContent {
  const subject = `Your job post is live — ${data.title}`;
  const on = data.closesOn ? formatDate(data.closesOn) : null;
  const blocks: Block[] = [
    {
      value:
        `Your post "${data.title}" has been approved and is now on ${siteConfig.name}. ` +
        (on ? `It stays open until ${on}, and we will remind you before it closes.` : ""),
    },
    { label: "Your post", value: data.title, href: data.jobUrl },
  ];
  if (on) blocks.push({ label: "Closes", value: on });
  return {
    subject,
    ...layout({ subject, heading: `Thanks${data.posterName ? `, ${data.posterName}` : ""}`, blocks }),
  };
}

export function jobRejected(data: JobDecidedData): EmailContent {
  const subject = `About your job post — ${data.title}`;
  const blocks: Block[] = [
    {
      value:
        `We looked at your post "${data.title}" and have not published it. ` +
        `The reason is below; if you think we have got this wrong, reply to this email.`,
    },
    { label: "Reason", value: data.reason ?? "No reason was given." },
  ];
  return { subject, ...layout({ subject, heading: subject, blocks }) };
}

export interface JobExpiringData {
  title: string;
  posterName: string | null;
  jobUrl: string;
  closesOn: Date;
  /** Where to post again. */
  postUrl: string;
}

export function jobExpiring(data: JobExpiringData): EmailContent {
  const on = formatDate(data.closesOn);
  const subject = `Your job post closes on ${on} — ${data.title}`;
  const blocks: Block[] = [
    {
      value:
        `Your post "${data.title}" closes on ${on}. After that it comes off ${siteConfig.name} ` +
        `and stops taking applications. If the role is still open, post it again.`,
    },
    { label: "Your post", value: data.title, href: data.jobUrl },
    { label: "Closes", value: on },
    { label: "Still hiring?", value: "Post it again", href: data.postUrl },
  ];
  return {
    subject,
    ...layout({ subject, heading: `Closing soon${data.posterName ? `, ${data.posterName}` : ""}`, blocks }),
  };
}
