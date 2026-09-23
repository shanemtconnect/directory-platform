import { unsubscribes } from "@/lib/db/schema";
import { normaliseAddress } from "@/lib/email/unsubscribe";
import type { Viewer } from "@/lib/db/viewer";
import type { TestDb } from "@/lib/db/types";
import { writeAudit } from "./audit";

/**
 * The one write to `unsubscribes`. One unsubscribe is one unsubscribe for
 * ever, across every campaign and every quote broadcast — the readers
 * (`selectQuoteRecipients`, `quoteNotification`, `outreachCandidates`) all
 * compare `address_normalised` against `lower(trim(address))`, so that is
 * the one shape written here.
 *
 * Idempotent: a second click writes nothing and audits nothing. The audit
 * row names the listing the email was about, never the address — the
 * address is in the table this row is about.
 */
export async function recordUnsubscribe(
  tx: TestDb,
  viewer: Viewer,
  input: { email: string; listingId: string; reason: string; ip: string | null },
): Promise<{ written: boolean }> {
  const rows = await tx
    .insert(unsubscribes)
    .values({ addressNormalised: normaliseAddress(input.email), reason: input.reason })
    .onConflictDoNothing({ target: unsubscribes.addressNormalised })
    .returning({ id: unsubscribes.id });
  if (rows.length === 0) return { written: false };

  await writeAudit(tx, viewer, {
    action: "email.unsubscribed",
    entityType: "listing",
    entityId: input.listingId,
    meta: { reason: input.reason },
    ip: input.ip,
  });
  return { written: true };
}
