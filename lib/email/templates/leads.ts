import { siteConfig } from "@/config/site.config";
import { layout, unsubscribeBlock, type Block, type EmailContent } from "./layout";

/**
 * Lead-market mail (Task 58). Money arrives formatted and every value is
 * escaped by `layout`. `leadWon` is one of the only two places a sold
 * lead's contact details are ever shown (the other is the buyer's
 * /leads/<id> page); nothing else here carries more than a first name and
 * the brief.
 */

const greeting = (name: string | null): Block[] =>
  name !== null && name.trim() !== "" ? [{ value: `Hello ${name.trim()},` }] : [];

export interface LeadWonData {
  buyerName: string | null;
  listingName: string | null;
  /** Bought by a standing order (true) or off the board (false). */
  viaStandingOrder: boolean;
  /** What it cost, e.g. "£40". */
  price: string;
  name: string;
  email: string;
  phone: string | null;
  message: string;
  town: string;
  category: string | null;
  leadUrl: string;
}

export function leadWon(d: LeadWonData): EmailContent {
  const what = d.category === null ? "A new lead" : `A new ${d.category.toLowerCase()} lead`;
  const subject = `${what} in ${d.town}`;
  const blocks: Block[] = [
    ...greeting(d.buyerName),
    {
      value:
        (d.viaStandingOrder
          ? `Your standing order${d.listingName === null ? "" : ` for ${d.listingName}`} has bought a lead for ${d.price}. `
          : `You bought this lead${d.listingName === null ? "" : ` for ${d.listingName}`} for ${d.price}. `) +
        "The person asked to be contacted, so get in touch soon.",
    },
    { label: "Name", value: d.name },
    { label: "Email", value: d.email, href: `mailto:${d.email}` },
    { label: "Phone", value: d.phone ?? "No phone number given" },
    { label: "Town", value: d.category === null ? d.town : `${d.town} · ${d.category}` },
    { label: "What they asked for", value: d.message },
    { label: "This lead", value: "Details and 'report a bad lead'", href: d.leadUrl },
    {
      value:
        `Keep this email: we delete the contact details from the site ${siteConfig.leads.retainSoldDays} days after a sale.`,
    },
    {
      value:
        `If the number is dead, the address bounces or the person never asked, report it from the lead's page within ` +
        `${siteConfig.leads.refundWindowDays} days and we will look at a refund to your credit.`,
    },
  ];
  return { subject, ...layout({ subject, heading: d.viaStandingOrder ? "You have a new lead" : "Your lead's details", blocks }) };
}

export interface LeadTopupData {
  name: string | null;
  listingName: string;
  price: string;
  balance: string;
  creditUrl: string;
  ordersUrl: string;
}

export function leadTopup(d: LeadTopupData): EmailContent {
  const subject = `Your standing order for ${d.listingName} is paused`;
  const blocks: Block[] = [
    ...greeting(d.name),
    {
      value:
        `A lead came up that your standing order for ${d.listingName} would have bought at ${d.price}, but your credit ` +
        `balance is ${d.balance}. We have paused the order so it stops missing leads without telling you.`,
    },
    { label: "Top up", value: "Add credit", href: d.creditUrl },
    { label: "Then resume the order", value: "Your standing orders", href: d.ordersUrl },
  ];
  return { subject, ...layout({ subject, heading: "Standing order paused: not enough credit", blocks }) };
}

export interface LeadRefundDecidedData {
  name: string | null;
  approved: boolean;
  /** Whether the approval blocklisted the requester (not for `wrong_area` or `bounced`). */
  blocklisted: boolean;
  price: string;
  /** The reason as the buyer chose it, in words. */
  reason: string;
  firstName: string;
  brief: string;
  note: string | null;
  leadsUrl: string;
}

export function leadRefundDecided(d: LeadRefundDecidedData): EmailContent {
  const subject = d.approved ? `Lead refunded: ${d.price} back in your credit` : "Your bad-lead report was not approved";
  const blocks: Block[] = [
    ...greeting(d.name),
    { label: "The lead", value: `${d.firstName}: ${d.brief}` },
    { label: "You reported", value: d.reason },
    d.approved
      ? {
          value: d.blocklisted
            ? `We have refunded ${d.price} to your lead credit, and that phone number and address can no longer send leads.`
            : `We have refunded ${d.price} to your lead credit.`,
        }
      : { value: "We looked at your report and have not refunded this lead." },
    ...(d.note === null ? [] : [{ label: d.approved ? "Note" : "Why", value: d.note }]),
    { label: "Your leads", value: "Purchases and refunds", href: d.leadsUrl },
  ];
  return { subject, ...layout({ subject, heading: d.approved ? "Refund approved" : "Refund not approved", blocks }) };
}

export interface BoardDigestData {
  name: string | null;
  openCount: number;
  boardUrl: string;
  ordersUrl: string;
  /** From `signUnsubscribe({ userId, email })`. Required: no digest goes without it. */
  unsubscribeToken: string;
}

export function boardDigest(d: BoardDigestData): EmailContent {
  const leads = d.openCount === 1 ? "1 open lead" : `${d.openCount} open leads`;
  const subject = `${leads} in your area on ${siteConfig.name}`;
  const blocks: Block[] = [
    ...greeting(d.name),
    { value: `There ${d.openCount === 1 ? "is" : "are"} ${leads} on the board in the places you cover. Nobody has bought ${d.openCount === 1 ? "it" : "them"} yet.` },
    { label: "The board", value: "See the leads", href: d.boardUrl },
    { label: "Get them automatically", value: "Your standing orders", href: d.ordersUrl },
    unsubscribeBlock(d.unsubscribeToken),
  ];
  return { subject, ...layout({ subject, heading: `${leads} waiting`, blocks }) };
}
