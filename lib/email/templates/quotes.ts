import { siteConfig } from "@/config/site.config";
import { layout, type Block, type EmailContent } from "./layout";

/**
 * The quote broadcast's emails.
 *
 * A paid recipient gets the whole request — job, name, address, phone — with
 * reply-to set to the requester, because a lead that needs a login to read
 * is a lead answered a day late. A free recipient is told a request arrived
 * for their category in their town and where to see it, and nothing more:
 * that is the upgrade, stated plainly rather than dressed up.
 */

export interface QuoteRecipientEmailData {
  listingName: string;
  /** Absolute URL of the owner's leads page for this listing. */
  leadsUrl: string;
  /** Absolute URL of /pricing, for the free-tier copy. */
  pricingUrl: string;
  cityName: string;
  categoryName: string;
  contactVisible: boolean;
  requester: { name: string; email: string; phone: string | null };
  message: string;
}

export function quoteToRecipient(data: QuoteRecipientEmailData): EmailContent {
  const e = siteConfig.entity;
  if (!data.contactVisible) {
    const subject = `A quote request for ${data.categoryName} in ${data.cityName}`;
    const blocks: Block[] = [
      {
        value:
          `Someone in ${data.cityName} is asking ${data.categoryName} ${e.plural} for a quote, ` +
          `and ${data.listingName} was one of the ${e.plural} it went to.`,
      },
      {
        value:
          `Free listings are told a request arrived. The job and the person's contact details ` +
          `are shown on paid plans — upgrade and this request, and any earlier ones, open up.`,
      },
      { label: "See your plan options", value: data.pricingUrl, href: data.pricingUrl },
      { label: "Your leads", value: data.leadsUrl, href: data.leadsUrl },
    ];
    return {
      subject,
      ...layout({ subject, heading: `A quote request was sent to ${data.listingName}`, blocks }),
    };
  }

  const subject = `Quote request: ${data.categoryName} in ${data.cityName}`;
  const blocks: Block[] = [
    { label: "The job", value: data.message },
    { label: "From", value: data.requester.name },
    { label: "Email", value: data.requester.email, href: `mailto:${data.requester.email}` },
  ];
  // Phone is optional on the form. An empty "Phone:" line reads like a fault.
  if (data.requester.phone !== null && data.requester.phone.trim() !== "") {
    blocks.push({ label: "Phone", value: data.requester.phone });
  }
  blocks.push({ label: "Where", value: data.cityName });
  blocks.push({ label: e.Singular, value: data.listingName });
  blocks.push({ label: "Mark it won or lost", value: data.leadsUrl, href: data.leadsUrl });
  return {
    subject,
    // Replying goes to the person who asked; quoting should be one keystroke.
    replyTo: data.requester.email,
    ...layout({ subject, heading: `Someone in ${data.cityName} wants a quote`, blocks }),
  };
}

export interface QuoteAcknowledgementData {
  requesterName: string;
  cityName: string;
  categoryName: string;
  /** How many businesses were actually written to. Never a padded number. */
  recipientCount: number;
  message: string;
}

export function quoteAcknowledgement(data: QuoteAcknowledgementData): EmailContent {
  const e = siteConfig.entity;
  const n = data.recipientCount;
  const noun = n === 1 ? e.singular : e.plural;
  const subject = `Your quote request went to ${n} ${noun}`;
  const blocks: Block[] = [
    {
      value:
        `Hello ${data.requesterName}. We sent your request for ${data.categoryName} in ` +
        `${data.cityName} to ${n} ${noun}. Any that can help will reply to you directly, ` +
        `so keep an eye on your inbox.`,
    },
    { label: "What you asked for", value: data.message },
    { value: `${siteConfig.name} never charges you for this, and we don't sell your details.` },
  ];
  return { subject, ...layout({ subject, heading: `Sent to ${n} ${noun}`, blocks }) };
}
