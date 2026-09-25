import { siteConfig } from "@/config/site.config";
import type { Territory } from "@/lib/db/schema/lead-market";

/**
 * The lead market's rules that need no database (Task 58): board pricing,
 * the refund policy (D10) and the standing-order territory encoding. Pure,
 * so the pages, the actions, the queries and the worker read one copy.
 */

const DAY_MS = 86_400_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** A listing may hold at most this many standing orders. */
export const MAX_STANDING_ORDERS_PER_LISTING = 5;

/** `siteConfig.leads.floor` in minor units: the board price and the lowest standing-order price. */
export function floorCents(): number {
  return Math.round(siteConfig.leads.floor * 100);
}

/**
 * What a lead costs on the board right now (D9): its price until
 * `half_price_at`, half of it (rounded up to a whole cent) from then on.
 */
export function currentPriceCents(lead: { priceCents: number; halfPriceAt: Date }, at: Date): number {
  return at.getTime() >= lead.halfPriceAt.getTime() ? Math.ceil(lead.priceCents / 2) : lead.priceCents;
}

/* ------------------------------------------------------------ territories */

/** A territory as a `<select>` option value: `national`, `region:<slug>`, `city:<uuid>`. */
export function encodeTerritory(t: Territory): string {
  return t.kind === "national" ? "national" : `${t.kind}:${t.id}`;
}

/** The inverse; null for anything that is not one of the three shapes. */
export function decodeTerritory(value: string): Territory | null {
  if (value === "national") return { kind: "national" };
  const [kind, id, ...rest] = value.split(":");
  if (rest.length > 0 || id === undefined) return null;
  if (kind === "city" && UUID.test(id)) return { kind: "city", id: id.toLowerCase() };
  if (kind === "region" && SLUG.test(id)) return { kind: "region", id };
  return null;
}

/* ---------------------------------------------------------------- refunds */

export type RefundReason = "dead_phone" | "wrong_person" | "bounced" | "spam" | "never_asked" | "wrong_area";

/** D10: the only grounds for a refund, as the buyer's form and the board print them. */
export const REFUND_REASONS: readonly { value: RefundReason; label: string }[] = [
  { value: "dead_phone", label: "The phone number is dead or not in service" },
  { value: "wrong_person", label: "The number or address belongs to someone who did not make the request" },
  { value: "bounced", label: "The email address bounces" },
  { value: "spam", label: "The request is spam, a test or abusive" },
  { value: "never_asked", label: "The person says they never asked for quotes" },
  { value: "wrong_area", label: "The job is not in the town the lead was listed under" },
];

export const REFUND_REASON_LABELS: Readonly<Record<RefundReason, string>> = Object.fromEntries(
  REFUND_REASONS.map((r) => [r.value, r.label]),
) as Record<RefundReason, string>;

export const isRefundReason = (value: string): value is RefundReason =>
  REFUND_REASONS.some((r) => r.value === value);

/** D10: what is NOT refunded, printed on the board beside the reasons that are. */
export function noRefundReasons(): string[] {
  return [
    "The customer chose someone else, or stopped replying after the first contact.",
    "The customer decided not to go ahead, or their dates or budget changed.",
    "You could not get through straight away, but the number and the address both work.",
    "You bought the lead by mistake, or no longer want leads of that kind.",
    `A report made more than ${siteConfig.leads.refundWindowDays} days after you bought the lead.`,
  ];
}

/** A bad lead may be reported for `refundWindowDays` after it was bought. */
export function refundWindowOpen(boughtAt: Date, at: Date): boolean {
  return at.getTime() < boughtAt.getTime() + siteConfig.leads.refundWindowDays * DAY_MS;
}

/** D10: a buyer who asks for refunds on more than a third of their leads is flagged for the admin, not blocked. */
export const REFUND_FLAG_RATE = 1 / 3;

/** Refund requests (any outcome) per lead bought. */
export function refundRate(purchases: number, refundRequests: number): number {
  return purchases === 0 ? 0 : refundRequests / purchases;
}

export function isRefundRateFlagged(purchases: number, refundRequests: number): boolean {
  return refundRate(purchases, refundRequests) > REFUND_FLAG_RATE + 1e-9;
}

/** How long an approved refund keeps the lead's phone and email off the market. */
export const BLOCKLIST_MONTHS = 12;

/* ------------------------------------------------------------- coverage */

/** What a standing order needs to know about a lead to decide whether it covers it. */
export interface LeadPlace {
  readonly cityId: string;
  /** `regionSlug(cities.region)`, or null for a city with no region. */
  readonly regionSlug: string | null;
  readonly categoryId: string | null;
}

/**
 * D8: an order covers a lead when one of its territories is the lead's city,
 * the city's region or national, AND its categories are null (all) or
 * include the lead's. A lead with no category matches only an all-categories
 * order. The allocation query says the same thing in SQL (jsonb
 * containment); this is the copy the crons and the digest use.
 */
export function orderCovers(
  order: { readonly territories: readonly Territory[]; readonly categoryIds: readonly string[] | null },
  lead: LeadPlace,
): boolean {
  const place = order.territories.some((t) =>
    t.kind === "national" || (t.kind === "city" && t.id === lead.cityId) || (t.kind === "region" && t.id === lead.regionSlug),
  );
  if (!place) return false;
  if (order.categoryIds === null) return true;
  return lead.categoryId !== null && order.categoryIds.includes(lead.categoryId);
}
