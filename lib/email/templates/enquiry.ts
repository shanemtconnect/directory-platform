import { siteConfig } from "@/config/site.config";
import { layout, type Block, type EmailContent } from "./layout";

/**
 * The two enquiry notifications. Both carry the whole enquiry in the body:
 * a lead that requires logging in to read is a lead answered a day late, and
 * the owner tiers that pay for this expect the message in their inbox.
 */

export interface EnquiryEmailData {
  listingName: string;
  /** Absolute URL of the public listing page. */
  listingUrl: string;
  from: { name: string; email: string; phone: string | null };
  message: string;
}

function enquiryBlocks(data: EnquiryEmailData): Block[] {
  const blocks: Block[] = [
    { label: "From", value: data.from.name },
    { label: "Email", value: data.from.email, href: `mailto:${data.from.email}` },
  ];
  // Phone is optional on the form. An empty "Phone:" line reads like a fault.
  if (data.from.phone !== null && data.from.phone.trim() !== "") {
    blocks.push({ label: "Phone", value: data.from.phone });
  }
  blocks.push({ label: "Message", value: data.message });
  blocks.push({ label: siteConfig.entity.Singular, value: data.listingName, href: data.listingUrl });
  return blocks;
}

export function enquiryToOwner(data: EnquiryEmailData): EmailContent {
  const subject = `New enquiry for your ${siteConfig.entity.singular}: ${data.listingName}`;
  return {
    subject,
    // Replying goes to the person who asked. Answering a lead should be one
    // keystroke, not a copy-paste of an address out of the body.
    replyTo: data.from.email,
    ...layout({
      subject,
      heading: `You have a new enquiry`,
      blocks: enquiryBlocks(data),
    }),
  };
}

export function enquiryToAdmin(data: EnquiryEmailData): EmailContent {
  const subject = `Enquiry: ${data.listingName}`;
  return {
    subject,
    replyTo: data.from.email,
    ...layout({
      subject,
      heading: `New enquiry on ${siteConfig.name}`,
      blocks: enquiryBlocks(data),
    }),
  };
}
