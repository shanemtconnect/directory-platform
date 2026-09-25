import { siteConfig } from "@/config/site.config";
import { layout, type Block, type EmailContent } from "./layout";

/**
 * Lead-credit mail (Task 57). Money arrives already formatted: the worker
 * knows the locale and currency, this file knows sentences.
 */
export interface TopupReceiptData {
  /** The account's name; null or blank writes no greeting line. */
  name: string | null;
  /** What this top-up added, e.g. "£50". */
  amount: string;
  /** The balance after it, e.g. "£75". */
  balance: string;
  creditUrl: string;
}

export function topupReceipt(data: TopupReceiptData): EmailContent {
  const subject = `${data.amount} of lead credit added on ${siteConfig.name}`;
  const blocks: Block[] = [
    ...(data.name !== null && data.name.trim() !== "" ? [{ value: `Hello ${data.name.trim()},` }] : []),
    { value: `Your top-up of ${data.amount} has gone through. Your lead credit balance is now ${data.balance}.` },
    { label: "Your credit", value: "Balance and history", href: data.creditUrl },
    { value: "PayPal emails the payment receipt separately. Credit is spent on leads and is not paid back out as cash." },
  ];
  return { subject, ...layout({ subject, heading: "Lead credit added", blocks }) };
}
