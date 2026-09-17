import { siteConfig } from "@/config/site.config";
import { layout, type Block, type EmailContent } from "./layout";

/**
 * The renewal reminders.
 *
 * A renewal is a charge somebody is about to take from a business, so every
 * one of these says the DATE, the amount's plan, and how to stop it. A
 * reminder that says "renews soon" and hides the cancel link is the kind of
 * email that produces chargebacks rather than renewals.
 */

/** 30 days, a week, and the morning of. The job sends one email per offset. */
export const REMINDER_OFFSETS: readonly number[] = [30, 7, 0];

export interface RenewalReminderData {
  listingName: string;
  listingUrl: string;
  billingUrl: string;
  /** From the tier spec — never a plan name written into this file. */
  tierLabel: string;
  interval: "annual" | "monthly";
  renewsOn: Date;
  offsetDays: number;
}

function formatDate(value: Date): string {
  return new Intl.DateTimeFormat(siteConfig.locale, {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: siteConfig.timezone,
  }).format(value);
}

function heading(offsetDays: number, on: string): string {
  if (offsetDays <= 0) return `Your plan renews today`;
  if (offsetDays <= 7) return `Your plan renews on ${on}`;
  return `Your plan renews in ${offsetDays} days`;
}

export function renewalReminder(data: RenewalReminderData): EmailContent {
  const on = formatDate(data.renewsOn);
  const subject = `${heading(data.offsetDays, on)} — ${data.listingName}`;
  const every = data.interval === "annual" ? "every year" : "every month";

  const blocks: Block[] = [
    {
      value:
        `Your ${data.tierLabel} plan for ${data.listingName} renews on ${on}. ` +
        `PayPal takes it automatically ${every}, so there is nothing for you to do to keep it.`,
    },
    { label: "Plan", value: data.tierLabel },
    { label: "Renews", value: on },
    { label: "Your listing", value: data.listingName, href: data.listingUrl },
    {
      label: "Change or cancel",
      value: "Manage this plan",
      href: data.billingUrl,
    },
    {
      value:
        `Cancelling before ${on} stops the renewal. You keep the plan until that date either ` +
        `way, and your contact details, map pin and enquiry form stay on the site for free ` +
        `afterwards.`,
    },
  ];

  return { subject, ...layout({ subject, heading: heading(data.offsetDays, on), blocks }) };
}
