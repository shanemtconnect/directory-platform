import { and, eq, sql } from "drizzle-orm";
import { siteConfig } from "@/config/site.config";
import { leads, listings, quoteRecipients, quoteRequests } from "@/lib/db/schema";
import { publishedListings } from "@/lib/db/queries/listings";
import { now } from "@/lib/clock";
import { countryProfile } from "@/lib/geo/countries";
import { normalisePhone } from "@/lib/geo/phone";
import { checkLeadRules, normaliseEmail } from "@/lib/leads/rules";
import type { Viewer } from "@/lib/db/viewer";
import type { TestDb } from "@/lib/db/types";
import { writeAudit } from "./audit";

/**
 * Where leads come from (pay-per-lead, D5). Three doors, one row shape:
 *
 *  - a VERIFIED get-quotes request that reached no paid-tier listing in its
 *    town (`createLeadFromQuote`) — a paying local keeps getting its free
 *    quotes exactly as before, and nothing is sold over its head;
 *  - a lead-capture box (home page, rails), once its requester has clicked
 *    the same verification link (`createCaptureLead`);
 *  - an enquiry to an unclaimed listing we hold no address for — a message
 *    that would otherwise go nowhere (`createEnquiryLead`).
 *
 * Every lead is created OPEN at `siteConfig.leads.floor`, with its half-price
 * and expiry dates fixed at creation, after `checkLeadRules` (D11). None of
 * these emails anyone and none sells anything: Task 58 does that from
 * `afterLeadCreated` (lib/leads/hooks.ts), which the CALLERS invoke. The
 * feature flag is also the callers' business — these functions write when
 * asked, so they can be tested without one.
 *
 * `null` means "no lead was created": a paid local exists, the rules refused,
 * the source row is not in a state that makes a lead, or one already exists.
 */

export type Lead = typeof leads.$inferSelect;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_MS = 86_400_000;

/* ------------------------------------------------------------------ brief */

export const BRIEF_MAX = 160;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The country's postcode shape, unanchored, for finding one inside text. */
function postcodeFinder(country: string): RegExp {
  const source = countryProfile(country).postcodePattern.source.replace(/^\^/, "").replace(/\$$/, "");
  return new RegExp(`\\b${source}\\b`, "gi");
}

/**
 * The one line a buyer reads before paying: the job, and nothing that lets
 * them skip paying. Strips anything with an `@` (addresses), links, any run
 * of five or more digits even with spaces or dashes between them (phone
 * numbers, ZIPs), the site country's postcode shape, and every part of the
 * requester's name after the first. Whitespace collapsed, capped at
 * `BRIEF_MAX` on a word boundary.
 */
export function briefFor(
  message: string,
  opts: { name?: string | null; country?: string } = {},
): string {
  let text = message.replace(/\s+/g, " ");
  text = text.replace(/\S*@\S*/g, " ");
  text = text.replace(/\b(?:https?:\/\/|www\.)\S+/gi, " ");
  text = text.replace(/\+?\d[\d\s().\-]*\d/g, (run) => (run.replace(/\D/g, "").length >= 5 ? " " : run));
  text = text.replace(postcodeFinder(opts.country ?? siteConfig.country), " ");
  const [, ...rest] = (opts.name ?? "").trim().split(/\s+/).filter((w) => w.length > 1);
  for (const part of rest) {
    text = text.replace(new RegExp(`\\b${escapeRegExp(part)}\\b`, "gi"), " ");
  }
  text = text.replace(/\s+([,.;:!?])/g, "$1").replace(/([,.;:])(?:\s*[,.;:])+/g, "$1");
  text = text.replace(/\s+/g, " ").trim();

  if (text.length <= BRIEF_MAX) return text;
  const cut = text.slice(0, BRIEF_MAX - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > 40 ? cut.slice(0, space) : cut).replace(/[\s,.;:]+$/, "")}…`;
}

function firstNameOf(name: string): string {
  return (name.trim().split(/\s+/)[0] ?? "").slice(0, 40);
}

/* ----------------------------------------------------------------- insert */

interface LeadFields {
  source: Lead["source"];
  quoteRequestId: string | null;
  listingId: string | null;
  cityId: string;
  categoryId: string | null;
  name: string;
  email: string;
  phone: string | null;
  message: string;
}

/** Rules, then the row, then its audit line. Shared by all three doors. */
async function insertLead(tx: TestDb, viewer: Viewer, fields: LeadFields): Promise<Lead | null> {
  const verdict = await checkLeadRules(tx, {
    email: fields.email, phone: fields.phone, country: siteConfig.country,
  });
  if (verdict !== "ok") return null;

  const at = now();
  const cfg = siteConfig.leads;
  const [lead] = await tx
    .insert(leads)
    .values({
      ...fields,
      firstName: firstNameOf(fields.name),
      brief: briefFor(fields.message, { name: fields.name }),
      phoneNormalised: normalisePhone(fields.phone, siteConfig.country),
      emailNormalised: normaliseEmail(fields.email),
      status: "open",
      priceCents: Math.round(cfg.floor * 100),
      halfPriceAt: new Date(at.getTime() + cfg.halfPriceAfterDays * DAY_MS),
      expiresAt: new Date(at.getTime() + cfg.deleteAfterDays * DAY_MS),
      createdAt: at,
      updatedAt: at,
    })
    .returning();

  await writeAudit(tx, viewer, {
    action: "lead.created",
    entityType: "lead",
    entityId: lead!.id,
    meta: { source: fields.source, quoteRequestId: fields.quoteRequestId, listingId: fields.listingId },
  });
  return lead!;
}

/* ------------------------------------------------------------------ doors */

/**
 * A verified get-quotes request becomes a lead when no listing it went to is
 * on a paid tier NOW (a listing that upgraded between the request and the
 * click already has the request on its leads page). Pending, expired and
 * spam requests make nothing; nor does a capture request, which has its own
 * door; nor does a request that is already a lead.
 */
export async function createLeadFromQuote(
  tx: TestDb,
  viewer: Viewer,
  quoteRequestId: string,
): Promise<Lead | null> {
  if (!UUID.test(quoteRequestId)) return null;

  const [request] = await tx
    .select({
      name: quoteRequests.name,
      email: quoteRequests.email,
      phone: quoteRequests.phone,
      message: quoteRequests.message,
      cityId: quoteRequests.cityId,
      categoryId: quoteRequests.categoryId,
      status: quoteRequests.status,
      source: quoteRequests.source,
      isSpam: quoteRequests.isSpam,
    })
    .from(quoteRequests)
    .where(eq(quoteRequests.id, quoteRequestId))
    .limit(1);
  if (!request || request.status !== "verified" || request.isSpam || request.source !== "quote") return null;
  if (request.email === null || request.message === null || request.cityId === null) return null;

  const [paidLocal] = await tx
    .select({ id: listings.id })
    .from(quoteRecipients)
    .innerJoin(listings, eq(listings.id, quoteRecipients.listingId))
    .where(and(eq(quoteRecipients.quoteRequestId, quoteRequestId), sql`${listings.tier} <> 'free'`))
    .limit(1);
  if (paidLocal) return null;

  const [existing] = await tx
    .select({ id: leads.id })
    .from(leads)
    .where(eq(leads.quoteRequestId, quoteRequestId))
    .limit(1);
  if (existing) return null;

  return insertLead(tx, viewer, {
    source: "quote",
    quoteRequestId,
    listingId: null,
    cityId: request.cityId,
    categoryId: request.categoryId,
    name: request.name ?? request.email,
    email: request.email,
    phone: request.phone,
    message: request.message,
  });
}

export interface CaptureLeadInput {
  cityId: string;
  categoryId: string | null;
  name: string;
  email: string;
  phone: string | null;
  message: string;
  /** The verified capture request it came from, when there is one. */
  quoteRequestId?: string | null;
}

/**
 * A capture box's request, after its verification click. Never broadcast,
 * so there is no paid local to defer to: the whole point of the box is a
 * lead with no listing target.
 */
export async function createCaptureLead(
  tx: TestDb,
  viewer: Viewer,
  input: CaptureLeadInput,
): Promise<Lead | null> {
  if (!UUID.test(input.cityId)) return null;
  if (input.categoryId !== null && !UUID.test(input.categoryId)) return null;
  if (input.quoteRequestId) {
    const [existing] = await tx
      .select({ id: leads.id })
      .from(leads)
      .where(eq(leads.quoteRequestId, input.quoteRequestId))
      .limit(1);
    if (existing) return null;
  }
  return insertLead(tx, viewer, {
    source: "capture",
    quoteRequestId: input.quoteRequestId ?? null,
    listingId: null,
    cityId: input.cityId,
    categoryId: input.categoryId,
    name: input.name,
    email: input.email,
    phone: input.phone,
    message: input.message,
  });
}

export interface EnquiryLeadInput {
  name: string;
  email: string;
  phone: string | null;
  message: string;
}

/**
 * An enquiry to a published, UNCLAIMED listing with no email on file — one
 * nobody would ever read. A claimed listing is written to at its owner's
 * account, and a listing with an address is written to there, so neither
 * makes a lead: the enquiry reaches the business it was meant for.
 */
export async function createEnquiryLead(
  tx: TestDb,
  viewer: Viewer,
  listingId: string,
  input: EnquiryLeadInput,
): Promise<Lead | null> {
  if (!UUID.test(listingId)) return null;

  const [target] = await tx
    .select({ cityId: listings.cityId, categoryId: listings.primaryCategoryId })
    .from(listings)
    .where(and(
      eq(listings.id, listingId),
      publishedListings(viewer),
      eq(listings.claimStatus, "unclaimed"),
      sql`nullif(trim(${listings.email}), '') is null`,
    ))
    .limit(1);
  if (!target) return null;

  return insertLead(tx, viewer, {
    source: "enquiry",
    quoteRequestId: null,
    listingId,
    cityId: target.cityId,
    categoryId: target.categoryId,
    name: input.name,
    email: input.email,
    phone: input.phone,
    message: input.message,
  });
}
