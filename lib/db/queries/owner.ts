import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { cities, enquiries, listings, profiles } from "@/lib/db/schema";
import { now } from "@/lib/clock";
import type { Viewer } from "@/lib/db/viewer";
import type { Db } from "@/lib/db/client";
import { writeAudit } from "./audit";

/**
 * The owner portal's data layer.
 *
 * Global constraint 24 says a signed-in user sees only listings where
 * `owner_id` is their own profile, and that the QUERY enforces it rather than
 * the page. So no function here takes a profile id from its caller: each one
 * resolves the viewer's own profile and joins on it. A listing id can then be
 * anything at all — it simply will not match.
 *
 * Admins get no special treatment here. `/admin` is where a colleague's
 * listing is edited, with the audit trail that goes with it; the owner portal
 * is for what you own.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertSignedIn(viewer: Viewer): asserts viewer is Exclude<Viewer, { role: "public" }> {
  if (viewer.role === "public") throw new Error("FORBIDDEN");
}

/**
 * The scoping predicate, as one expression every query below reuses.
 *
 * A correlated subquery rather than a join so it can be dropped into a WHERE
 * clause on `listings` or on `enquiries` unchanged — and so there is exactly
 * one place the ownership rule is written.
 */
export function ownedByViewer(viewer: Exclude<Viewer, { role: "public" }>) {
  return sql`${listings.ownerId} = (
    select ${profiles.id} from ${profiles} where ${profiles.userId} = ${viewer.userId}
  )`;
}

export interface OwnerListing {
  id: string;
  name: string;
  /** Site-relative path to the public page. */
  path: string;
  status: "draft" | "pending" | "published" | "rejected" | "archived" | "removed";
  tier: "free" | "essential" | "premium";
  claimStatus: "unclaimed" | "claimed" | "verified";
  enquiryCount: number;
  /** Enquiries with no `read_at`, so the dashboard can say what is waiting. */
  unreadEnquiries: number;
}

export async function ownerListings(tx: Db, viewer: Viewer): Promise<OwnerListing[]> {
  assertSignedIn(viewer);

  const unread = sql<number>`(
    select count(*)::int from ${enquiries}
    where ${enquiries.listingId} = ${listings.id}
      and ${enquiries.readAt} is null
      and ${enquiries.isSpam} = false
  )`;

  const rows = await tx
    .select({
      id: listings.id,
      name: listings.name,
      slug: listings.slug,
      citySlug: cities.slug,
      // No published-only gate: an owner whose listing is under review or
      // archived must still be able to see and edit it. The gate exists to
      // keep unpublished rows off the PUBLIC pages, and this is not one.
      status: listings.status,
      tier: listings.tier,
      claimStatus: listings.claimStatus,
      enquiryCount: listings.enquiryCount,
      unreadEnquiries: unread,
    })
    .from(listings)
    .innerJoin(cities, eq(cities.id, listings.cityId))
    .where(ownedByViewer(viewer))
    .orderBy(listings.name);

  return rows.map(({ slug, citySlug, ...rest }) => ({ ...rest, path: `/${citySlug}/${slug}` }));
}

/**
 * `unreadEnquiries` is deliberately absent: the editor does not show a count,
 * and carrying a field this query never computes would mean returning 0 as if
 * it were an answer.
 */
export interface OwnerListingDetail extends Omit<OwnerListing, "unreadEnquiries"> {
  description: string | null;
  phone: string | null;
  website: string | null;
  socials: unknown;
  openingHours: unknown;
}

export async function ownerListing(
  tx: Db,
  viewer: Viewer,
  listingId: string,
): Promise<OwnerListingDetail | null> {
  assertSignedIn(viewer);
  if (!UUID.test(listingId)) return null;

  const [row] = await tx
    .select({
      id: listings.id,
      name: listings.name,
      slug: listings.slug,
      citySlug: cities.slug,
      status: listings.status,
      tier: listings.tier,
      claimStatus: listings.claimStatus,
      enquiryCount: listings.enquiryCount,
      description: listings.description,
      phone: listings.phone,
      website: listings.website,
      socials: listings.socials,
      openingHours: listings.openingHours,
    })
    .from(listings)
    .innerJoin(cities, eq(cities.id, listings.cityId))
    .where(and(eq(listings.id, listingId), ownedByViewer(viewer)))
    .limit(1);
  if (!row) return null;

  const { slug, citySlug, ...rest } = row;
  return { ...rest, path: `/${citySlug}/${slug}` };
}

/**
 * The fields an owner may change, and no others.
 *
 * Named explicitly rather than spread from the form: `status`, `tier`,
 * `owner_id`, `rank_boost` and `verified_at` are all columns on the same row,
 * and a patch object built from a form post would otherwise be one extra
 * field away from self-promotion to premium.
 */
export interface OwnerListingPatch {
  description: string | null;
  phone: string | null;
  website: string | null;
  /** A list of profile URLs. Rendered only on tiers with `showSocial`. */
  socials: string[];
  /** `{ mon: "09:00-17:00", tue: "Closed", … }`. Free text per day on purpose. */
  openingHours: Record<string, string>;
}

export type OwnerUpdateResult =
  | { outcome: "saved"; path: string }
  | { outcome: "not-found" };

export async function updateOwnerListing(
  tx: Db,
  viewer: Viewer,
  listingId: string,
  patch: OwnerListingPatch,
  /** The request address, for the audit row. `null` only off a request. */
  ip: string | null,
): Promise<OwnerUpdateResult> {
  assertSignedIn(viewer);
  if (!UUID.test(listingId)) return { outcome: "not-found" };

  const existing = await ownerListing(tx, viewer, listingId);
  if (!existing) return { outcome: "not-found" };

  const at = now();
  await tx
    .update(listings)
    .set({
      description: patch.description,
      phone: patch.phone,
      website: patch.website,
      socials: patch.socials,
      openingHours: patch.openingHours,
      updatedAt: at,
    })
    .where(and(eq(listings.id, listingId), ownedByViewer(viewer)));

  // Global constraint 22: the audit row lands in the same transaction, and it
  // carries the address the edit came from. Without one the row can say what
  // changed but not whether the session that changed it was the owner's.
  await writeAudit(tx, viewer, {
    action: "listing.edited",
    entityType: "listing",
    entityId: listingId,
    meta: { fields: Object.keys(patch) },
    ip,
  });

  return { outcome: "saved", path: existing.path };
}

export interface OwnerEnquiry {
  id: string;
  createdAt: Date;
  name: string | null;
  email: string | null;
  phone: string | null;
  message: string | null;
  readAt: Date | null;
  repliedAt: Date | null;
}

/**
 * One listing's enquiries.
 *
 * Projected column by column, like every other read of a sensitive table: the
 * row also carries `is_spam` and the enquirer's IP address, which we hold for
 * abuse handling and which is not the listing owner's to see.
 */
export async function ownerEnquiries(
  tx: Db,
  viewer: Viewer,
  listingId: string,
): Promise<OwnerEnquiry[]> {
  assertSignedIn(viewer);
  if (!UUID.test(listingId)) return [];

  return tx
    .select({
      id: enquiries.id,
      createdAt: enquiries.createdAt,
      name: enquiries.name,
      email: enquiries.email,
      phone: enquiries.phone,
      message: enquiries.message,
      readAt: enquiries.readAt,
      repliedAt: enquiries.repliedAt,
    })
    .from(enquiries)
    .innerJoin(listings, eq(listings.id, enquiries.listingId))
    .where(and(
      eq(enquiries.listingId, listingId),
      eq(enquiries.isSpam, false),
      ownedByViewer(viewer),
    ))
    .orderBy(desc(enquiries.createdAt));
}

/**
 * Marks an enquiry read or replied. Returns whether anything changed, so the
 * caller can tell "not yours" from "done" without a second query.
 *
 * `responded_in_minutes` is written once and only once: it feeds the honest
 * "usually replies within N hours" figure on the listing, and a second click
 * on Replied a day later must not turn a two-hour response into a day.
 */
export async function markEnquiryHandled(
  tx: Db,
  viewer: Viewer,
  enquiryId: string,
  action: "read" | "replied",
  /** The request address, for the audit row. `null` only off a request. */
  ip: string | null,
): Promise<boolean> {
  assertSignedIn(viewer);
  if (!UUID.test(enquiryId)) return false;

  const at = now();
  const owned = sql`exists (
    select 1 from ${listings}
    where ${listings.id} = ${enquiries.listingId} and ${ownedByViewer(viewer)}
  )`;

  // An ISO string with an explicit cast, not the Date object: interpolating a
  // Date into a `sql` template hands the driver a value it declares as
  // timestamptz and then refuses to encode, and the whole statement throws.
  const stamp = sql`${at.toISOString()}::timestamptz`;

  const set =
    action === "read"
      ? { readAt: sql`coalesce(${enquiries.readAt}, ${stamp})`, updatedAt: at }
      : {
          // Replying implies reading, whatever order the buttons were pressed in.
          readAt: sql`coalesce(${enquiries.readAt}, ${stamp})`,
          repliedAt: sql`coalesce(${enquiries.repliedAt}, ${stamp})`,
          respondedInMinutes: sql`coalesce(
            ${enquiries.respondedInMinutes},
            greatest(0, floor(extract(epoch from (${stamp} - ${enquiries.createdAt})) / 60))::int
          )`,
          updatedAt: at,
        };

  const updated = await tx
    .update(enquiries)
    .set(set)
    .where(and(eq(enquiries.id, enquiryId), eq(enquiries.isSpam, false), owned))
    .returning({ id: enquiries.id });
  if (updated.length === 0) return false;

  // Global constraint 22. `responded_in_minutes` feeds the public "usually
  // replies within N hours" figure, so marking an enquiry replied is a write
  // that changes what the site tells strangers — it is audited like any other.
  // Only on a real change: a no-op click is not an event.
  await writeAudit(tx, viewer, {
    action: action === "read" ? "enquiry.marked_read" : "enquiry.marked_replied",
    entityType: "enquiry",
    entityId: enquiryId,
    meta: null,
    ip,
  });

  return true;
}

/** Unread enquiries across everything the viewer owns, for the dashboard. */
export async function ownerUnreadCount(tx: Db, viewer: Viewer): Promise<number> {
  assertSignedIn(viewer);
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(enquiries)
    .innerJoin(listings, eq(listings.id, enquiries.listingId))
    .where(and(isNull(enquiries.readAt), eq(enquiries.isSpam, false), ownedByViewer(viewer)));
  return row?.n ?? 0;
}
