import { and, eq, sql } from "drizzle-orm";
import { enquiries, listings } from "@/lib/db/schema";
import { publishedListings } from "@/lib/db/queries/listings";
import type { Viewer } from "@/lib/db/viewer";
import type { TestDb } from "@/test/db";

/**
 * The enquiry write, behind the same published-only gate as every public read.
 *
 * An enquiry is a lead, and a lead is the thing a listing is worth paying for.
 * A pending, rejected or removed listing must not collect them: the business
 * would never see them, and a submitter would be told their message had gone
 * somewhere it had not.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface EnquiryInput {
  listingId: string;
  name: string;
  email: string;
  phone: string | null;
  message: string;
  /** Null when no proxy header identified the sender. Never a placeholder. */
  ip: string | null;
}

export type EnquiryResult =
  | { outcome: "created"; enquiryId: string }
  | { outcome: "unknown-listing" };

/**
 * Caller supplies the transaction: the insert and the counter must land
 * together or a listing's enquiry count starts drifting from its enquiries.
 */
export async function createEnquiry(
  tx: TestDb,
  viewer: Viewer,
  input: EnquiryInput,
): Promise<EnquiryResult> {
  if (!UUID.test(input.listingId)) return { outcome: "unknown-listing" };

  const [target] = await tx
    .select({ id: listings.id })
    .from(listings)
    .where(and(eq(listings.id, input.listingId), publishedListings(viewer)))
    .limit(1);
  if (!target) return { outcome: "unknown-listing" };

  const [row] = await tx
    .insert(enquiries)
    .values({
      listingId: input.listingId,
      name: input.name,
      email: input.email,
      phone: input.phone,
      message: input.message,
      ip: input.ip,
    })
    .returning({ id: enquiries.id });

  await tx
    .update(listings)
    .set({ enquiryCount: sql`${listings.enquiryCount} + 1` })
    .where(eq(listings.id, input.listingId));

  return { outcome: "created", enquiryId: row!.id };
}
