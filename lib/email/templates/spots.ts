import { siteConfig } from "@/config/site.config";
import { layout, unsubscribeBlock, type Block, type EmailContent } from "./layout";

/**
 * Featured-spot mail (Task 45).
 *
 * The outbid email says three things and no more: what happened to the
 * owner's own bid, what it takes to get back, and where to click. It never
 * quotes anybody else's amount — the "amount to retake" is derived from
 * them, which is as much as the public bidding page discloses. Money
 * arrives already formatted: the worker knows the site's locale and
 * currency, this file knows sentences.
 */

export interface SpotOutbidEmailData {
  listingName: string;
  /** "Leeds" or "Plumbing in Leeds". */
  spotLabel: string;
  kind: "lost-first" | "dropped-out";
  /** The position the bid holds now; null when it holds none. */
  position: number | null;
  positions: number;
  /** What a bid must be, now, to retake first (lost-first) or re-enter (dropped-out). */
  amount: string;
  /** The bidding page with that amount prefilled. */
  bidUrl: string;
  leaderboardUrl: string;
}

export function spotOutbid(data: SpotOutbidEmailData): EmailContent {
  const e = siteConfig.entity;
  const lostFirst = data.kind === "lost-first";
  const subject = lostFirst
    ? `${data.listingName} is no longer first in ${data.spotLabel}`
    : `${data.listingName} is no longer featured in ${data.spotLabel}`;
  const heading = lostFirst ? "Your bid lost first place" : "Your bid was outbid";
  const what = lostFirst
    ? `Another ${e.singular} has bid more for the featured spots in ${data.spotLabel}. ` +
      `${data.listingName} is now #${data.position ?? "?"} of ${data.positions} — still featured, no longer first.`
    : `Other ${e.plural} have bid more for the ${data.positions} featured spots in ${data.spotLabel}. ` +
      `${data.listingName} is no longer featured in ${data.spotLabel}; it keeps its ordinary place in the list and is not charged for this spot.`;
  const how = lostFirst
    ? `A bid of ${data.amount} a month would put it back at #1.`
    : `A bid of ${data.amount} a month would put it back among the featured.`;
  const blocks: Block[] = [
    { value: what },
    { value: how },
    { label: "Bid now", value: `Bid ${data.amount} a month`, href: data.bidUrl },
    { label: "Who is featured", value: `The featured ${e.plural} in ${data.spotLabel}`, href: data.leaderboardUrl },
    {
      value:
        "Raising a bid needs your approval at PayPal before it counts. If you would rather not bid again, " +
        "there is nothing to do.",
    },
  ];
  return { subject, ...layout({ subject, heading, blocks }) };
}

export interface SpotDigestOwnerEmailData {
  listingName: string;
  emptyCount: number;
  /** The lowest entry price among the empty spots, formatted. */
  fromAmount: string;
  bidUrl: string;
  /** From `signUnsubscribe`; null when no key is configured (no link, then). */
  unsubscribeToken: string | null;
}

export function spotDigestToOwner(data: SpotDigestOwnerEmailData): EmailContent {
  const e = siteConfig.entity;
  const n = data.emptyCount;
  const subject = n === 1 ? "1 spot near you is empty" : `${n} spots near you are empty`;
  const blocks: Block[] = [
    {
      value:
        `${siteConfig.name} features up to ${siteConfig.featured.positions} ${e.plural} above every list. ` +
        `Right now ${n === 1 ? "one spot" : `${n} spots`} on the pages ${data.listingName} appears on ` +
        `${n === 1 ? "has" : "have"} room — from ${data.fromAmount}/month.`,
    },
    {
      value:
        "Featured placement is a monthly bid: the highest bids take the spots, and if you are ever outbid you pay nothing for that spot.",
    },
    { label: "See the spots", value: `Featured spots for ${data.listingName}`, href: data.bidUrl },
  ];
  if (data.unsubscribeToken !== null) blocks.push(unsubscribeBlock(data.unsubscribeToken));
  return { subject, ...layout({ subject, heading: subject, blocks }) };
}

export interface SpotDigestAdminRow {
  label: string;
  filled: number;
  positions: number;
  floor: string;
  /** The top featured amount, or "—" when nobody is featured. */
  top: string;
}

export interface SpotDigestAdminEmailData {
  rows: SpotDigestAdminRow[];
  total: number;
  csvUrl: string;
}

export function spotDigestToAdmin(data: SpotDigestAdminEmailData): EmailContent {
  const subject = `Featured spots: ${data.total} empty this month`;
  const blocks: Block[] = [
    {
      value:
        `${data.total} featured spot${data.total === 1 ? "" : "s"} across the site ${data.total === 1 ? "has" : "have"} room. ` +
        "The CSV is the outreach list.",
    },
    ...data.rows.map((r) => ({
      value: `${r.label}: ${r.filled} of ${r.positions} taken, floor ${r.floor}, top ${r.top}`,
    })),
    { label: "Export", value: "Download the empty spots as CSV", href: data.csvUrl },
  ];
  return { subject, ...layout({ subject, heading: subject, blocks }) };
}
