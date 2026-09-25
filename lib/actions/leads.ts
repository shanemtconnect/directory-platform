"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { db } from "@/lib/db/client";
import { currentViewer, requireAdmin } from "@/lib/auth/viewer";
import { ensureProfile } from "@/lib/auth/profile";
import { features } from "@/lib/features/flags";
import { clientIp } from "@/lib/spam/client-ip";
import { isUuid } from "@/lib/actions/validation";
import { parseCreditAmount } from "@/lib/credits/format";
import { decodeTerritory } from "@/lib/leads/market";
import {
  adminDeleteLead, buyLead, createStandingOrder, decideRefund, deleteStandingOrder, requestRefund,
  setLeadDigestOptOut, setStandingOrderStatus, updateStandingOrder, type StandingOrderResult,
} from "@/lib/db/queries/lead-market";
import type { Territory } from "@/lib/db/schema/lead-market";
import type { TestDb } from "@/lib/db/types";

/**
 * The lead market's writes (Task 58). Every one 404s with the flag off: a
 * server action is an endpoint, and `guardFeature` on the page is not a
 * boundary for it. Signed-out callers are sent to sign in; the queries
 * re-check ownership (a listing, an order, a purchase) themselves. Each
 * outcome lands on a page that can say it, via a query string.
 */

function assertFlag(): void {
  if (!features.leadMarketplace) throw new Error("NOT_FOUND");
}

const str = (form: FormData, key: string): string => String(form.get(key) ?? "").trim();
const tx = <T>(fn: (h: TestDb) => Promise<T>): Promise<T> => db.transaction(async (t) => fn(t as unknown as TestDb));

async function signedIn(next: string) {
  const viewer = await currentViewer();
  if (viewer.role === "public") redirect(`/login?next=${next}`);
  return viewer;
}

/** The board's page a buy was pressed on, so the answer lands where the buyer was. */
function boardPath(form: FormData): string {
  const page = Number(str(form, "page"));
  return Number.isInteger(page) && page > 1 ? `/leads/page/${page}` : "/leads";
}

export async function buyLeadAction(form: FormData): Promise<void> {
  assertFlag();
  const viewer = await signedIn("/leads");
  const leadId = str(form, "leadId");
  const listingId = str(form, "listingId");
  const back = boardPath(form);
  if (!isUuid(leadId)) redirect(`${back}?buy=gone`);
  const result = await tx((h) => buyLead(h, viewer, leadId, listingId));
  if (result.outcome === "bought") redirect(`/leads/${leadId}`);
  redirect(`${back}?buy=${result.outcome}`);
}

export async function reportLeadAction(form: FormData): Promise<void> {
  assertFlag();
  const leadId = str(form, "leadId");
  const viewer = await signedIn(isUuid(leadId) ? `/leads/${leadId}` : "/leads");
  const result = await tx((h) => requestRefund(h, viewer, { leadId, reason: str(form, "reason"), note: str(form, "note") }));
  redirect(`/leads/${leadId}?report=${result.outcome}`);
}

const ACCOUNT_LEADS = "/account/leads";

function orderOutcome(result: StandingOrderResult): string {
  if (result.outcome !== "invalid") return result.outcome;
  const [field] = Object.keys(result.errors);
  return `invalid-${field ?? "order"}`;
}

/** Create (no `orderId`) or edit (with one) a standing order. Price in major units, e.g. "30" or "30.50". */
export async function saveStandingOrderAction(form: FormData): Promise<void> {
  assertFlag();
  const viewer = await signedIn(ACCOUNT_LEADS);
  const territories = form
    .getAll("territories")
    .map((v) => decodeTerritory(String(v)))
    .filter((t): t is Territory => t !== null);
  const picked = form.getAll("categories").map(String).filter(isUuid);
  const categoryIds = picked.length === 0 ? null : picked;
  const cents = parseCreditAmount(str(form, "price"));
  if (cents === null || cents <= 0) redirect(`${ACCOUNT_LEADS}?order=invalid-price`);

  const orderId = str(form, "orderId");
  const result = await tx((h) =>
    orderId !== ""
      ? updateStandingOrder(h, viewer, orderId, { territories, categoryIds, priceCents: cents })
      : createStandingOrder(h, viewer, { listingId: str(form, "listingId"), territories, categoryIds, priceCents: cents }),
  );
  redirect(`${ACCOUNT_LEADS}?order=${orderOutcome(result)}`);
}

export async function setStandingOrderStatusAction(form: FormData): Promise<void> {
  assertFlag();
  const viewer = await signedIn(ACCOUNT_LEADS);
  const status = str(form, "status") === "paused" ? "paused" : "active";
  const result = await tx((h) => setStandingOrderStatus(h, viewer, str(form, "orderId"), status));
  redirect(`${ACCOUNT_LEADS}?order=${result.outcome === "saved" ? status : result.outcome}`);
}

export async function deleteStandingOrderAction(form: FormData): Promise<void> {
  assertFlag();
  const viewer = await signedIn(ACCOUNT_LEADS);
  const result = await tx((h) => deleteStandingOrder(h, viewer, str(form, "orderId")));
  redirect(`${ACCOUNT_LEADS}?order=${result.outcome === "saved" ? "deleted" : result.outcome}`);
}

/** The account page's checkbox for the weekly board digest. */
export async function setLeadDigestAction(form: FormData): Promise<void> {
  assertFlag();
  const viewer = await signedIn(ACCOUNT_LEADS);
  const optOut = str(form, "digest") !== "on";
  await tx(async (h) => {
    const profile = await ensureProfile(h, viewer);
    return setLeadDigestOptOut(h, viewer, { profileId: profile.id, optOut });
  });
  redirect(`${ACCOUNT_LEADS}?digest=${optOut ? "off" : "on"}`);
}

const ADMIN_LEADS = "/admin/leads";

export async function decideRefundAction(form: FormData): Promise<void> {
  assertFlag();
  const viewer = await requireAdmin();
  const approve = str(form, "decision") === "approve";
  const ip = clientIp(await headers());
  const result = await tx((h) => decideRefund(h, viewer, str(form, "refundId"), { approve, note: str(form, "note"), ip }));
  redirect(`${ADMIN_LEADS}?refund=${result.outcome}`);
}

export async function adminDeleteLeadAction(form: FormData): Promise<void> {
  assertFlag();
  const viewer = await requireAdmin();
  const result = await tx((h) => adminDeleteLead(h, viewer, str(form, "leadId")));
  redirect(`${ADMIN_LEADS}?deleted=${result}`);
}
