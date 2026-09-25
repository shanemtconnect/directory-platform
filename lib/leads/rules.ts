import { and, eq, gt, isNull, or } from "drizzle-orm";
import { leadBlocklist, leads } from "@/lib/db/schema";
import { now } from "@/lib/clock";
import { normalisePhone } from "@/lib/geo/phone";
import { isDisposableEmail } from "@/lib/spam/disposable-domains";
import type { TestDb } from "@/lib/db/types";

/**
 * The rejection rules a lead passes before it can be created (D11).
 *
 * In this order, cheapest first: a phone that does not normalise for the
 * site's country (or a premium / fiction range — lib/geo/phone.ts), an
 * address at a throwaway inbox, a phone or address on the blocklist (a
 * refunded lead's, for twelve months), and the same phone or address on any
 * lead in the last thirty days. A refused lead is never created — the
 * request it came from is still delivered where it was going.
 */

export const DUPLICATE_WINDOW_DAYS = 30;

export type LeadRejection = "phone_invalid" | "disposable_email" | "blocklisted" | "duplicate";
export type RuleVerdict = "ok" | { reason: LeadRejection };

export interface LeadRuleInput {
  email: string;
  phone: string | null;
  /** The site's country: `siteConfig.country`. */
  country: string;
}

/** The duplicate and blocklist key for an address. */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function checkLeadRules(tx: TestDb, input: LeadRuleInput): Promise<RuleVerdict> {
  const phone = normalisePhone(input.phone, input.country);
  if (phone === null) return { reason: "phone_invalid" };
  if (isDisposableEmail(input.email)) return { reason: "disposable_email" };

  const email = normaliseEmail(input.email);
  const at = now();

  const [blocked] = await tx
    .select({ id: leadBlocklist.id })
    .from(leadBlocklist)
    .where(and(
      or(
        and(eq(leadBlocklist.kind, "phone"), eq(leadBlocklist.value, phone)),
        and(eq(leadBlocklist.kind, "email"), eq(leadBlocklist.value, email)),
      ),
      or(isNull(leadBlocklist.expiresAt), gt(leadBlocklist.expiresAt, at)),
    ))
    .limit(1);
  if (blocked) return { reason: "blocklisted" };

  const since = new Date(at.getTime() - DUPLICATE_WINDOW_DAYS * 86_400_000);
  const [duplicate] = await tx
    .select({ id: leads.id })
    .from(leads)
    .where(and(
      or(eq(leads.phoneNormalised, phone), eq(leads.emailNormalised, email)),
      gt(leads.createdAt, since),
    ))
    .limit(1);
  if (duplicate) return { reason: "duplicate" };

  return "ok";
}
