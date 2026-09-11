import { and, asc, desc, eq, isNotNull, isNull, lte, or } from "drizzle-orm";
import { auditLog, cities, claims, listings, profiles, user } from "@/lib/db/schema";
import { publishedListings } from "@/lib/db/queries/listings";
import { matchesListingDomain } from "@/lib/claims/domain";
import { isTokenExpired, magicTokenExpiry, newMagicToken } from "@/lib/claims/token";
import { now } from "@/lib/clock";
import { isAdmin, type Viewer } from "@/lib/db/viewer";
import type { Db } from "@/lib/db/client";

/**
 * Everything the claim flow reads and writes.
 *
 * A claim is the moment a stranger becomes the owner of a row that describes
 * somebody else's business, so every function here is written around two
 * questions: who is asking, and what did they actually prove. The evidence
 * ladder is in `lib/claims/domain.ts`; this file is what the ladder decides
 * ABOUT — and the audit trail that says, months later, why a listing changed
 * hands.
 *
 * Phone OTP is deliberately absent. The enum carries the value so the column
 * does not need migrating when an SMS provider exists, but there is no
 * provider today and a rung that cannot actually verify anything is worse
 * than no rung at all.
 */

/** How long a decided claim's supporting documents are kept. */
export const DOCUMENT_RETENTION_DAYS = 30;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertSignedIn(viewer: Viewer): void {
  if (viewer.role === "public") throw new Error("FORBIDDEN");
}

function assertAdmin(viewer: Viewer): void {
  // A claim row carries the claimant's name, business address and the path to
  // a scan of their utility bill. Reading the queue is reading personal data.
  if (!isAdmin(viewer)) throw new Error("FORBIDDEN");
}

/**
 * Local until there is a shared one.
 *
 * Global constraint 22 requires an audit row in the same transaction as every
 * admin or owner mutation, and every caller here already has the transaction
 * open. Private on purpose: when the shared `writeAudit` lands, this is the
 * single place that changes.
 */
async function writeAudit(
  tx: Db,
  row: {
    actorId: string | null;
    action: string;
    entityId: string;
    entityType?: string;
    meta?: Record<string, unknown>;
    ip?: string | null;
  },
): Promise<void> {
  await tx.insert(auditLog).values({
    actorId: row.actorId,
    action: row.action,
    entityType: row.entityType ?? "claim",
    entityId: row.entityId,
    meta: row.meta ?? null,
    ip: row.ip ?? null,
  });
}

export interface ClaimableListing {
  id: string;
  name: string;
  /** Site-relative path to the public page, for links and revalidation. */
  path: string;
  website: string | null;
  claimStatus: "unclaimed" | "claimed" | "verified";
}

/**
 * The listing behind `/claim/[id]`, behind the same published-only gate as
 * every other public read. An unpublished listing is not claimable: doing so
 * would confirm to anyone with an id that a pending submission exists.
 */
export async function getClaimableListing(
  tx: Db,
  viewer: Viewer,
  listingId: string,
): Promise<ClaimableListing | null> {
  if (!UUID.test(listingId)) return null;
  const [row] = await tx
    .select({
      id: listings.id,
      name: listings.name,
      slug: listings.slug,
      citySlug: cities.slug,
      website: listings.website,
      claimStatus: listings.claimStatus,
    })
    .from(listings)
    .innerJoin(cities, eq(cities.id, listings.cityId))
    .where(and(eq(listings.id, listingId), publishedListings(viewer)))
    .limit(1);
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    path: `/${row.citySlug}/${row.slug}`,
    website: row.website,
    claimStatus: row.claimStatus,
  };
}

/**
 * The open claim a user already has on a listing, if any.
 *
 * One per listing per user: a second open claim is either a double-submit or
 * somebody trying two rungs of the ladder at once, and neither should leave a
 * duplicate for an admin to reconcile by hand.
 */
async function openClaim(
  tx: Db,
  listingId: string,
  profileId: string,
): Promise<{ id: string } | null> {
  const [row] = await tx
    .select({ id: claims.id })
    .from(claims)
    .where(and(
      eq(claims.listingId, listingId),
      eq(claims.userId, profileId),
      eq(claims.status, "pending"),
    ))
    .limit(1);
  return row ?? null;
}

export interface ClaimantInput {
  listingId: string;
  /** `profiles.id`, never `viewer.userId` — see global constraint 21. */
  profileId: string;
  claimantName: string | null;
  roleAtBusiness: string | null;
  ip: string | null;
  userAgent: string | null;
}

export type DomainClaimResult =
  | { outcome: "sent"; claimId: string; token: string; email: string }
  | { outcome: "domain-mismatch" }
  | { outcome: "already-claimed" }
  | { outcome: "unknown-listing" };

/**
 * The automatic rung. Proof is possession of a mailbox on the domain the
 * listing already advertises, so nothing is decided here — a token is minted
 * and the decision happens when it comes back through `verifyClaimToken`.
 */
export async function startDomainClaim(
  tx: Db,
  viewer: Viewer,
  input: ClaimantInput & { businessEmail: string },
): Promise<DomainClaimResult> {
  assertSignedIn(viewer);

  const listing = await getClaimableListing(tx, viewer, input.listingId);
  if (!listing) return { outcome: "unknown-listing" };
  if (listing.claimStatus !== "unclaimed") return { outcome: "already-claimed" };
  if (!matchesListingDomain(listing.website, input.businessEmail)) {
    return { outcome: "domain-mismatch" };
  }

  const email = input.businessEmail.trim().toLowerCase();
  const token = newMagicToken();
  const at = now();
  const values = {
    status: "pending" as const,
    claimantName: input.claimantName,
    roleAtBusiness: input.roleAtBusiness,
    businessEmail: email,
    evidenceType: "domain_email" as const,
    magicToken: token,
    magicTokenExpiresAt: magicTokenExpiry(),
    ip: input.ip,
    userAgent: input.userAgent,
    updatedAt: at,
  };

  const existing = await openClaim(tx, input.listingId, input.profileId);
  let claimId: string;
  if (existing) {
    // A new link every time. The usual reason to come back to this form is
    // that the first email never arrived.
    await tx.update(claims).set(values).where(eq(claims.id, existing.id));
    claimId = existing.id;
  } else {
    const [row] = await tx
      .insert(claims)
      .values({ listingId: input.listingId, userId: input.profileId, ...values })
      .returning({ id: claims.id });
    claimId = row!.id;
  }

  await writeAudit(tx, {
    actorId: input.profileId,
    action: "claim.requested",
    entityId: claimId,
    meta: { listingId: input.listingId, evidence: "domain_email" },
    ip: input.ip,
  });

  return { outcome: "sent", claimId, token, email };
}

export type VerifyResult =
  | { outcome: "approved"; claimId: string; listingId: string; listingName: string; path: string }
  | { outcome: "expired" }
  | { outcome: "already-claimed" }
  | { outcome: "unknown" };

/**
 * The magic link coming back.
 *
 * No viewer gate, and that is the design: the link went to an address on the
 * business's own domain, and whoever opens it is very often not in the browser
 * that started the claim. The TOKEN is the credential, and ownership goes to
 * the profile that requested the claim rather than to whoever clicked — so a
 * forwarded link cannot redirect a listing to a stranger.
 */
export async function verifyClaimToken(
  tx: Db,
  _viewer: Viewer,
  token: string,
): Promise<VerifyResult> {
  if (token.trim() === "") return { outcome: "unknown" };

  const [row] = await tx
    .select({
      id: claims.id,
      listingId: claims.listingId,
      userId: claims.userId,
      status: claims.status,
      expiresAt: claims.magicTokenExpiresAt,
      listingName: listings.name,
      listingSlug: listings.slug,
      citySlug: cities.slug,
      claimStatus: listings.claimStatus,
      ownerId: listings.ownerId,
    })
    .from(claims)
    .innerJoin(listings, eq(listings.id, claims.listingId))
    .innerJoin(cities, eq(cities.id, listings.cityId))
    .where(eq(claims.magicToken, token))
    .limit(1);
  if (!row) return { outcome: "unknown" };

  const path = `/${row.citySlug}/${row.listingSlug}`;
  const approved = {
    outcome: "approved" as const,
    claimId: row.id,
    listingId: row.listingId,
    listingName: row.listingName,
    path,
  };

  // Idempotent BEFORE the expiry check. People click the link twice, and the
  // second click landing on "this link has expired" after the first one worked
  // is a support ticket about a claim that is perfectly fine.
  if (row.status === "approved" && row.ownerId === row.userId) return approved;
  if (row.status !== "pending") return { outcome: "unknown" };
  if (isTokenExpired(row.expiresAt)) return { outcome: "expired" };
  if (row.claimStatus !== "unclaimed") return { outcome: "already-claimed" };

  const at = now();
  await tx
    .update(claims)
    .set({
      status: "approved",
      emailVerifiedAt: at,
      decidedAt: at,
      updatedAt: at,
    })
    .where(eq(claims.id, row.id));

  await tx
    .update(listings)
    .set({ ownerId: row.userId, claimStatus: "claimed", updatedAt: at })
    .where(eq(listings.id, row.listingId));

  await promoteToOwner(tx, row.userId);

  await writeAudit(tx, {
    actorId: row.userId,
    action: "claim.approved",
    entityId: row.id,
    meta: { listingId: row.listingId, evidence: "domain_email", automatic: true },
  });

  return approved;
}

/**
 * An approved claim makes somebody an owner. Admins keep their role — a
 * demotion from admin to owner would quietly lock a colleague out of /admin.
 */
async function promoteToOwner(tx: Db, profileId: string | null): Promise<void> {
  if (profileId === null) return;
  await tx
    .update(profiles)
    .set({ role: "owner", updatedAt: now() })
    .where(and(eq(profiles.id, profileId), eq(profiles.role, "user")));
}

export type DocumentClaimResult =
  | { outcome: "open"; claimId: string }
  | { outcome: "already-claimed" }
  | { outcome: "unknown-listing" };

/**
 * The manual rung. Opens the claim BEFORE the upload rather than after, so an
 * abandoned upload leaves a row an admin can see and the purge job can clear —
 * an object in the private bucket with no row pointing at it would never be
 * deleted by anything.
 */
export async function startDocumentClaim(
  tx: Db,
  viewer: Viewer,
  input: ClaimantInput & { evidenceNotes: string | null },
): Promise<DocumentClaimResult> {
  assertSignedIn(viewer);

  const listing = await getClaimableListing(tx, viewer, input.listingId);
  if (!listing) return { outcome: "unknown-listing" };
  if (listing.claimStatus !== "unclaimed") return { outcome: "already-claimed" };

  const at = now();
  const values = {
    status: "pending" as const,
    claimantName: input.claimantName,
    roleAtBusiness: input.roleAtBusiness,
    evidenceType: "document" as const,
    evidenceNotes: input.evidenceNotes,
    ip: input.ip,
    userAgent: input.userAgent,
    updatedAt: at,
  };

  const existing = await openClaim(tx, input.listingId, input.profileId);
  if (existing) {
    await tx.update(claims).set(values).where(eq(claims.id, existing.id));
    return { outcome: "open", claimId: existing.id };
  }

  const [row] = await tx
    .insert(claims)
    .values({ listingId: input.listingId, userId: input.profileId, ...values })
    .returning({ id: claims.id });

  await writeAudit(tx, {
    actorId: input.profileId,
    action: "claim.requested",
    entityId: row!.id,
    meta: { listingId: input.listingId, evidence: "document" },
    ip: input.ip,
  });

  return { outcome: "open", claimId: row!.id };
}

/**
 * Records where the uploaded proof landed. Scoped to the claimant's own open
 * claim: the key is chosen by the server, but the claim id travels through the
 * browser and must not be usable to write a path onto somebody else's claim.
 */
export async function attachClaimDocument(
  tx: Db,
  viewer: Viewer,
  input: { claimId: string; profileId: string; path: string },
): Promise<boolean> {
  assertSignedIn(viewer);
  if (!UUID.test(input.claimId)) return false;

  const updated = await tx
    .update(claims)
    .set({ proofDocumentPath: input.path, updatedAt: now() })
    .where(and(
      eq(claims.id, input.claimId),
      eq(claims.userId, input.profileId),
      eq(claims.status, "pending"),
    ))
    .returning({ id: claims.id });
  if (updated.length === 0) return false;

  await writeAudit(tx, {
    actorId: input.profileId,
    action: "claim.document_uploaded",
    entityId: input.claimId,
  });
  return true;
}

export interface PendingClaim {
  id: string;
  createdAt: Date;
  listingId: string;
  listingName: string;
  listingPath: string;
  claimantName: string | null;
  roleAtBusiness: string | null;
  businessEmail: string | null;
  evidenceType: "domain_email" | "phone_otp" | "document" | "id_document" | null;
  hasDocument: boolean;
}

export async function listPendingClaims(tx: Db, viewer: Viewer): Promise<PendingClaim[]> {
  assertAdmin(viewer);
  const rows = await tx
    .select({
      id: claims.id,
      createdAt: claims.createdAt,
      listingId: claims.listingId,
      listingName: listings.name,
      listingSlug: listings.slug,
      citySlug: cities.slug,
      claimantName: claims.claimantName,
      roleAtBusiness: claims.roleAtBusiness,
      businessEmail: claims.businessEmail,
      evidenceType: claims.evidenceType,
      proofDocumentPath: claims.proofDocumentPath,
      idDocumentPath: claims.idDocumentPath,
    })
    .from(claims)
    .innerJoin(listings, eq(listings.id, claims.listingId))
    .innerJoin(cities, eq(cities.id, listings.cityId))
    .where(eq(claims.status, "pending"))
    .orderBy(asc(claims.createdAt));

  return rows.map(({ listingSlug, citySlug, proofDocumentPath, idDocumentPath, ...rest }) => ({
    ...rest,
    listingPath: `/${citySlug}/${listingSlug}`,
    hasDocument: proofDocumentPath !== null || idDocumentPath !== null,
  }));
}

export interface ClaimDetail extends PendingClaim {
  status: "pending" | "approved" | "rejected" | "withdrawn";
  evidenceNotes: string | null;
  emailVerifiedAt: Date | null;
  decidedAt: Date | null;
  rejectionReason: string | null;
  documentsPurgedAt: Date | null;
  /** Which document slots hold an object, for the presigned-GET links. */
  documents: ("proof" | "id")[];
  claimantEmail: string | null;
  ip: string | null;
}

export async function getClaimForAdmin(
  tx: Db,
  viewer: Viewer,
  claimId: string,
): Promise<ClaimDetail | null> {
  assertAdmin(viewer);
  if (!UUID.test(claimId)) return null;

  const [row] = await tx
    .select({
      id: claims.id,
      createdAt: claims.createdAt,
      listingId: claims.listingId,
      listingName: listings.name,
      listingSlug: listings.slug,
      citySlug: cities.slug,
      claimantName: claims.claimantName,
      roleAtBusiness: claims.roleAtBusiness,
      businessEmail: claims.businessEmail,
      evidenceType: claims.evidenceType,
      evidenceNotes: claims.evidenceNotes,
      status: claims.status,
      emailVerifiedAt: claims.emailVerifiedAt,
      decidedAt: claims.decidedAt,
      rejectionReason: claims.rejectionReason,
      documentsPurgedAt: claims.documentsPurgedAt,
      proofDocumentPath: claims.proofDocumentPath,
      idDocumentPath: claims.idDocumentPath,
      ip: claims.ip,
    })
    .from(claims)
    .innerJoin(listings, eq(listings.id, claims.listingId))
    .innerJoin(cities, eq(cities.id, listings.cityId))
    .where(eq(claims.id, claimId))
    .limit(1);
  if (!row) return null;

  const documents: ("proof" | "id")[] = [];
  if (row.proofDocumentPath !== null) documents.push("proof");
  if (row.idDocumentPath !== null) documents.push("id");

  return {
    id: row.id,
    createdAt: row.createdAt,
    listingId: row.listingId,
    listingName: row.listingName,
    listingPath: `/${row.citySlug}/${row.listingSlug}`,
    claimantName: row.claimantName,
    roleAtBusiness: row.roleAtBusiness,
    businessEmail: row.businessEmail,
    claimantEmail: row.businessEmail,
    evidenceType: row.evidenceType,
    evidenceNotes: row.evidenceNotes,
    status: row.status,
    emailVerifiedAt: row.emailVerifiedAt,
    decidedAt: row.decidedAt,
    rejectionReason: row.rejectionReason,
    documentsPurgedAt: row.documentsPurgedAt,
    hasDocument: documents.length > 0,
    documents,
    ip: row.ip,
  };
}

/**
 * The object key behind one of a claim's document slots.
 *
 * Separate from `getClaimForAdmin` because the page never needs it: a key is
 * what the presigned-GET route signs, and it has no business travelling to a
 * browser inside an RSC payload.
 */
export async function claimDocumentKey(
  tx: Db,
  viewer: Viewer,
  claimId: string,
  slot: "proof" | "id",
): Promise<string | null> {
  assertAdmin(viewer);
  if (!UUID.test(claimId)) return null;
  const [row] = await tx
    .select({ proof: claims.proofDocumentPath, id: claims.idDocumentPath })
    .from(claims)
    .where(eq(claims.id, claimId))
    .limit(1);
  if (!row) return null;
  return slot === "proof" ? row.proof : row.id;
}

/** Written by the presigned-GET route: every look at a document is on record. */
export async function recordDocumentView(
  tx: Db,
  viewer: Viewer,
  input: { claimId: string; actorProfileId: string; slot: "proof" | "id"; ip: string | null },
): Promise<void> {
  assertAdmin(viewer);
  await writeAudit(tx, {
    actorId: input.actorProfileId,
    action: "claim.document_viewed",
    entityId: input.claimId,
    meta: { slot: input.slot },
    ip: input.ip,
  });
}

export type DecisionResult =
  | { outcome: "decided"; listingId: string; listingPath: string }
  | { outcome: "already-decided" }
  | { outcome: "reason-required" }
  | { outcome: "unknown" };

/**
 * Approve or reject, admin only, with the audit row in the same transaction.
 *
 * A rejection insists on a reason because the claimant is told what it was:
 * "rejected" with no explanation produces a support email and a second
 * identical claim.
 */
export async function decideClaim(
  tx: Db,
  viewer: Viewer,
  input: {
    claimId: string;
    decision: "approved" | "rejected";
    reason: string | null;
    actorProfileId: string;
    ip: string | null;
  },
): Promise<DecisionResult> {
  assertAdmin(viewer);
  if (!UUID.test(input.claimId)) return { outcome: "unknown" };

  const reason = (input.reason ?? "").trim();
  if (input.decision === "rejected" && reason === "") return { outcome: "reason-required" };

  const [row] = await tx
    .select({
      id: claims.id,
      listingId: claims.listingId,
      userId: claims.userId,
      status: claims.status,
      listingSlug: listings.slug,
      citySlug: cities.slug,
      claimStatus: listings.claimStatus,
    })
    .from(claims)
    .innerJoin(listings, eq(listings.id, claims.listingId))
    .innerJoin(cities, eq(cities.id, listings.cityId))
    .where(eq(claims.id, input.claimId))
    .limit(1);
  if (!row) return { outcome: "unknown" };
  if (row.status !== "pending") return { outcome: "already-decided" };
  if (input.decision === "approved" && row.claimStatus !== "unclaimed") {
    return { outcome: "already-decided" };
  }

  const at = now();
  await tx
    .update(claims)
    .set({
      status: input.decision,
      decidedBy: input.actorProfileId,
      decidedAt: at,
      rejectionReason: input.decision === "rejected" ? reason : null,
      updatedAt: at,
    })
    .where(eq(claims.id, row.id));

  if (input.decision === "approved") {
    await tx
      .update(listings)
      .set({ ownerId: row.userId, claimStatus: "claimed", updatedAt: at })
      .where(eq(listings.id, row.listingId));
    await promoteToOwner(tx, row.userId);
  }

  await writeAudit(tx, {
    actorId: input.actorProfileId,
    action: input.decision === "approved" ? "claim.approved" : "claim.rejected",
    entityId: row.id,
    meta: {
      listingId: row.listingId,
      ...(input.decision === "rejected" ? { reason } : {}),
    },
    ip: input.ip,
  });

  return {
    outcome: "decided",
    listingId: row.listingId,
    listingPath: `/${row.citySlug}/${row.listingSlug}`,
  };
}

export interface ClaimNotification {
  claimId: string;
  listingId: string;
  listingName: string;
  listingPath: string;
  claimantName: string | null;
  businessEmail: string | null;
  /** The signed-in account's address, which is where a decision is sent. */
  accountEmail: string | null;
  magicToken: string | null;
  status: "pending" | "approved" | "rejected" | "withdrawn";
  rejectionReason: string | null;
  evidenceType: "domain_email" | "phone_otp" | "document" | "id_document" | null;
}

/**
 * The worker's read model. Admin-only for the same reason the queue is: it is
 * an address, a name and a live credential in one row.
 */
export async function claimNotification(
  tx: Db,
  viewer: Viewer,
  claimId: string,
): Promise<ClaimNotification | null> {
  assertAdmin(viewer);
  if (!UUID.test(claimId)) return null;

  const [row] = await tx
    .select({
      claimId: claims.id,
      listingId: claims.listingId,
      listingName: listings.name,
      listingSlug: listings.slug,
      citySlug: cities.slug,
      claimantName: claims.claimantName,
      businessEmail: claims.businessEmail,
      magicToken: claims.magicToken,
      status: claims.status,
      rejectionReason: claims.rejectionReason,
      evidenceType: claims.evidenceType,
      profileId: claims.userId,
    })
    .from(claims)
    .innerJoin(listings, eq(listings.id, claims.listingId))
    .innerJoin(cities, eq(cities.id, listings.cityId))
    .where(eq(claims.id, claimId))
    .limit(1);
  if (!row) return null;

  let accountEmail: string | null = null;
  if (row.profileId !== null) {
    const [account] = await tx
      .select({ email: user.email })
      .from(profiles)
      .innerJoin(user, eq(user.id, profiles.userId))
      .where(eq(profiles.id, row.profileId))
      .limit(1);
    accountEmail = account?.email ?? null;
  }

  return {
    claimId: row.claimId,
    listingId: row.listingId,
    listingName: row.listingName,
    listingPath: `/${row.citySlug}/${row.listingSlug}`,
    claimantName: row.claimantName,
    businessEmail: row.businessEmail,
    accountEmail,
    magicToken: row.magicToken,
    status: row.status,
    rejectionReason: row.rejectionReason,
    evidenceType: row.evidenceType,
  };
}

export interface PurgeableClaim {
  id: string;
  /** Every object key still held for this claim. Empty is never returned. */
  paths: string[];
}

/**
 * Claims decided more than the retention window ago that still hold documents.
 *
 * The cutoff is computed from `now()` rather than in SQL with `interval` so a
 * test can move the clock instead of waiting a month.
 */
export async function claimsWithPurgeableDocuments(
  tx: Db,
  viewer: Viewer,
): Promise<PurgeableClaim[]> {
  assertAdmin(viewer);
  const cutoff = new Date(now().getTime() - DOCUMENT_RETENTION_DAYS * 86_400_000);

  const rows = await tx
    .select({
      id: claims.id,
      proof: claims.proofDocumentPath,
      idDoc: claims.idDocumentPath,
    })
    .from(claims)
    .where(and(
      isNotNull(claims.decidedAt),
      lte(claims.decidedAt, cutoff),
      isNull(claims.documentsPurgedAt),
      or(isNotNull(claims.proofDocumentPath), isNotNull(claims.idDocumentPath)),
    ))
    .orderBy(asc(claims.decidedAt));

  return rows.map((r) => ({
    id: r.id,
    paths: [r.proof, r.idDoc].filter((p): p is string => p !== null),
  }));
}

/**
 * Called once the objects are gone from the bucket. Nulls the paths so nothing
 * can try to presign a key that no longer exists, and stamps the purge so the
 * row is never picked up again.
 */
export async function markClaimDocumentsPurged(
  tx: Db,
  viewer: Viewer,
  claimId: string,
  paths: string[],
): Promise<void> {
  assertAdmin(viewer);
  const at = now();
  await tx
    .update(claims)
    .set({
      proofDocumentPath: null,
      idDocumentPath: null,
      documentsPurgedAt: at,
      updatedAt: at,
    })
    .where(eq(claims.id, claimId));

  await writeAudit(tx, {
    actorId: null,
    action: "claim.documents_purged",
    entityId: claimId,
    meta: { count: paths.length, retentionDays: DOCUMENT_RETENTION_DAYS },
  });
}

/** Newest first, for the claimant's own view of what they have asked for. */
export async function claimsForProfile(
  tx: Db,
  viewer: Viewer,
  profileId: string,
): Promise<{ id: string; listingName: string; listingPath: string; status: string; rejectionReason: string | null; createdAt: Date }[]> {
  assertSignedIn(viewer);
  const rows = await tx
    .select({
      id: claims.id,
      listingName: listings.name,
      listingSlug: listings.slug,
      citySlug: cities.slug,
      status: claims.status,
      rejectionReason: claims.rejectionReason,
      createdAt: claims.createdAt,
    })
    .from(claims)
    .innerJoin(listings, eq(listings.id, claims.listingId))
    .innerJoin(cities, eq(cities.id, listings.cityId))
    .where(eq(claims.userId, profileId))
    .orderBy(desc(claims.createdAt));

  return rows.map(({ listingSlug, citySlug, ...rest }) => ({
    ...rest,
    listingPath: `/${citySlug}/${listingSlug}`,
  }));
}
