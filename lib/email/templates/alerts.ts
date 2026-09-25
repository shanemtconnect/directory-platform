import { siteConfig } from "@/config/site.config";
import { layout, unsubscribeBlock, type Block, type EmailContent } from "./layout";

/**
 * The saved-search digest (Task 54): what is new for one saved search since
 * the last digest. At most DIGEST_MAX_MATCHES lines; the rest are one "and N
 * more" link back to the search itself. Every digest carries the one-click
 * unsubscribe for THIS search and the link to manage all of them.
 */

export const DIGEST_MAX_MATCHES = 10;

export interface SavedSearchDigestData {
  kind: "listings" | "jobs";
  /** What the person saved it as. */
  label: string;
  /** Newest first; the template shows the first ten. */
  matches: { title: string; url: string; place: string | null }[];
  /** How many new matches there are in all — may exceed `matches` (the worker scans a bounded number). */
  total: number;
  /** Absolute URL of the saved search on the site — where "and N more" goes. */
  searchUrl: string;
  /** Absolute URL of /account/alerts. */
  manageUrl: string;
  /** From `signUnsubscribe({ savedSearchId, email })`. Required: no digest goes without it. */
  unsubscribeToken: string;
}

export function savedSearchDigest(data: SavedSearchDigestData): EmailContent {
  const e = siteConfig.entity;
  const n = Math.max(data.total, data.matches.length);
  const noun = data.kind === "jobs" ? (n === 1 ? "job" : "jobs") : n === 1 ? e.singular : e.plural;
  const subject = `${n} new ${noun} for "${data.label}"`;

  const shown = data.matches.slice(0, DIGEST_MAX_MATCHES);
  const blocks: Block[] = [
    { value: `New on ${siteConfig.name} since we last wrote about your saved search "${data.label}":` },
    ...shown.map((m) => ({
      label: m.place === null ? m.title : `${m.title} — ${m.place}`,
      value: m.url,
      href: m.url,
    })),
  ];
  const rest = n - shown.length;
  if (rest > 0) {
    blocks.push({ label: `And ${rest} more`, value: data.searchUrl, href: data.searchUrl });
  }
  blocks.push({ label: "Change how often, or stop", value: data.manageUrl, href: data.manageUrl });
  blocks.push(unsubscribeBlock(data.unsubscribeToken));

  return { subject, ...layout({ subject, heading: `${n} new ${noun} for your saved search`, blocks }) };
}
