import { and, eq } from "drizzle-orm";
import { auditLog, cities, enquiries, listings } from "@/lib/db/schema";
import { isAdmin, type Viewer } from "@/lib/db/viewer";
import { PARKED_SUBMISSION_ACTION } from "./submissions";
import type { TestDb } from "@/test/db";

/**
 * The read models the notification job sends from.
 *
 * They live here rather than in the job because everything they touch is
 * either unpublished or personal: a pending listing, a submitter's address, an
 * enquirer's message. Admin-only, and the worker is the only caller.
 */

function assertWorker(viewer: Viewer): void {
  if (!isAdmin(viewer)) throw new Error("FORBIDDEN");
}

export interface EnquiryNotification {
  enquiry: { name: string; email: string; phone: string | null; message: string };
  listing: {
    name: string;
    /** The business's own address. Null on most rows. */
    email: string | null;
    /** Enquiries only reach a contact once somebody has claimed the listing. */
    claimed: boolean;
    /** Site-relative path to the public page. */
    path: string;
  };
}

export async function enquiryNotification(
  tx: TestDb,
  viewer: Viewer,
  enquiryId: string,
): Promise<EnquiryNotification | null> {
  assertWorker(viewer);

  const [row] = await tx
    .select({
      name: enquiries.name,
      email: enquiries.email,
      phone: enquiries.phone,
      message: enquiries.message,
      listingName: listings.name,
      listingEmail: listings.email,
      claimStatus: listings.claimStatus,
      listingSlug: listings.slug,
      citySlug: cities.slug,
    })
    .from(enquiries)
    .innerJoin(listings, eq(listings.id, enquiries.listingId))
    .innerJoin(cities, eq(cities.id, listings.cityId))
    .where(eq(enquiries.id, enquiryId))
    .limit(1);
  if (!row) return null;

  // The columns are nullable and the form's validation is not the database's.
  // Without an address there is nobody to reply to and without a message there
  // is nothing to forward, so such a row is not a notifiable enquiry. A missing
  // name is survivable: the address identifies the sender well enough.
  if (row.email === null || row.message === null) return null;

  return {
    enquiry: {
      name: row.name ?? row.email,
      email: row.email,
      phone: row.phone,
      message: row.message,
    },
    listing: {
      name: row.listingName,
      email: row.listingEmail,
      claimed: row.claimStatus !== "unclaimed",
      path: `/${row.citySlug}/${row.listingSlug}`,
    },
  };
}

export interface SubmissionNotification {
  listingName: string;
  /** Null when the submitted town matched nothing we hold and the row is parked. */
  cityName: string | null;
  submitter: { name: string; email: string };
}

/** What `createSubmission` wrote into `custom_fields.submission` / the audit row. */
interface StoredSubmission {
  submitterName?: unknown;
  submitterEmail?: unknown;
  submittedCity?: unknown;
}

function submitterFrom(stored: StoredSubmission): { name: string; email: string } | null {
  const name = stored.submitterName;
  const email = stored.submitterEmail;
  if (typeof name !== "string" || typeof email !== "string" || email === "") return null;
  return { name, email };
}

export async function submissionNotification(
  tx: TestDb,
  viewer: Viewer,
  listingId: string,
): Promise<SubmissionNotification | null> {
  assertWorker(viewer);

  const [row] = await tx
    .select({
      name: listings.name,
      cityName: cities.name,
      customFields: listings.customFields,
      submittedByEmail: listings.submittedByEmail,
    })
    .from(listings)
    .innerJoin(cities, eq(cities.id, listings.cityId))
    .where(eq(listings.id, listingId))
    .limit(1);
  if (!row) return null;

  const stored = (row.customFields as { submission?: StoredSubmission } | null)?.submission ?? {};
  const submitter = submitterFrom(stored);
  if (!submitter) return null;

  return { listingName: row.name, cityName: row.cityName, submitter };
}

/**
 * The parked variant. There is no listing row, so everything comes back out of
 * the audit entry the submission was filed as.
 */
export async function parkedSubmissionNotification(
  tx: TestDb,
  viewer: Viewer,
  parkedId: string,
): Promise<SubmissionNotification | null> {
  assertWorker(viewer);

  const [row] = await tx
    .select({ meta: auditLog.meta })
    .from(auditLog)
    .where(and(eq(auditLog.id, parkedId), eq(auditLog.action, PARKED_SUBMISSION_ACTION)))
    .limit(1);
  if (!row) return null;

  const meta = (row.meta ?? {}) as StoredSubmission & { listing?: { name?: unknown } };
  const submitter = submitterFrom(meta);
  const name = meta.listing?.name;
  if (!submitter || typeof name !== "string") return null;

  return { listingName: name, cityName: null, submitter };
}
