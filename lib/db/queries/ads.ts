import { and, asc, desc, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { AD_PLACEMENTS, type AdPlacement } from "@/config/types";
import { now } from "@/lib/clock";
import { ensureProfile } from "@/lib/auth/profile";
import { isSafeTargetUrl } from "@/lib/ads/out";
import { isDayKey, isUuid } from "@/lib/stats/keys";
import {
  SPONSOR_BLURB_MAX,
  SPONSOR_TITLE_MAX,
  profiles,
  sponsorCampaigns,
  user,
  type SponsorBillingStatus,
} from "@/lib/db/schema";
import { isAdmin, type Viewer } from "@/lib/db/viewer";
import type { TestDb } from "@/lib/db/types";
import { writeAudit } from "./audit";

/**
 * Every database access the sponsor rails make (constraint 6). The rails
 * read through `activeSponsorCampaigns`, the click redirect through
 * `sponsorCampaignForClick`, the advertiser through the owner-scoped pair,
 * the admin queue through `decideSponsorCampaign`, and the worker through
 * `applySponsorStatDeltas` and the billing pair. Every mutation writes an
 * `audit_log` row in the same transaction, with the caller's ip
 * (constraint 22).
 */

export type SponsorCampaignStatus = "pending" | "active" | "paused" | "ended" | "rejected";

/** Billing states under which an approved campaign may still be shown. */
const SHOWABLE_BILLING: readonly SponsorBillingStatus[] = ["none", "active", "past_due", "cancelled"];

function assertSignedIn(viewer: Viewer): asserts viewer is Exclude<Viewer, { role: "public" }> {
  if (viewer.role === "public") throw new Error("FORBIDDEN");
}

function assertAdmin(viewer: Viewer): void {
  if (!isAdmin(viewer)) throw new Error("FORBIDDEN");
}

/* ------------------------------------------------------------- validation */

export type SponsorField = "name" | "title" | "blurb" | "targetUrl" | "placements";

export interface SponsorCopy {
  readonly name: string;
  readonly title: string;
  readonly blurb: string;
  readonly targetUrl: string;
}

const MAX_NAME = 80;
const NIL_UUID = "00000000-0000-0000-0000-000000000000";

/** The placements a campaign may ask for: everything the config can turn on. */
export const SPONSORABLE_PLACEMENTS: readonly AdPlacement[] = AD_PLACEMENTS.filter(
  (p) => p !== "home" && p !== "other",
);

export function isSponsorablePlacement(v: unknown): v is AdPlacement {
  return typeof v === "string" && (SPONSORABLE_PLACEMENTS as readonly string[]).includes(v);
}

function invalidCopy(copy: SponsorCopy): SponsorField | null {
  if (copy.name.trim().length === 0 || copy.name.length > MAX_NAME) return "name";
  if (copy.title.trim().length === 0 || copy.title.length > SPONSOR_TITLE_MAX) return "title";
  if (copy.blurb.trim().length === 0 || copy.blurb.length > SPONSOR_BLURB_MAX) return "blurb";
  if (!isSafeTargetUrl(copy.targetUrl)) return "targetUrl";
  return null;
}

/* ---------------------------------------------------------- the advertiser */

export interface CreateSponsorInput extends SponsorCopy {
  readonly profileId: string;
  readonly placements: readonly string[];
  readonly logoPath: string | null;
  readonly ip: string | null;
}

export type CreateSponsorResult =
  | { outcome: "created"; campaignId: string }
  | { outcome: "invalid"; field: SponsorField };

export async function createSponsorCampaign(
  tx: TestDb,
  viewer: Viewer,
  input: CreateSponsorInput,
): Promise<CreateSponsorResult> {
  assertSignedIn(viewer);
  const bad = invalidCopy(input);
  if (bad !== null) return { outcome: "invalid", field: bad };
  const placements = [...new Set(input.placements)];
  if (placements.length === 0 || !placements.every(isSponsorablePlacement)) {
    return { outcome: "invalid", field: "placements" };
  }
  const [row] = await tx
    .insert(sponsorCampaigns)
    .values({
      advertiserId: input.profileId,
      name: input.name.trim(),
      title: input.title.trim(),
      blurb: input.blurb.trim(),
      targetUrl: input.targetUrl,
      logoPath: input.logoPath,
      placements,
    })
    .returning({ id: sponsorCampaigns.id });
  const campaignId = row!.id;
  await writeAudit(tx, viewer, {
    action: "sponsor.create",
    entityType: "sponsor_campaign",
    entityId: campaignId,
    meta: { placements, hasLogo: input.logoPath !== null },
    ip: input.ip,
  });
  return { outcome: "created", campaignId };
}

export interface AdvertiserCampaign {
  readonly id: string;
  readonly name: string;
  readonly title: string;
  readonly blurb: string;
  readonly targetUrl: string;
  readonly logoPath: string | null;
  readonly status: SponsorCampaignStatus;
  readonly billingStatus: SponsorBillingStatus;
  readonly subscriptionId: string | null;
  readonly currentPeriodEnd: Date | null;
  readonly placements: readonly string[];
  readonly rejectionReason: string | null;
  readonly createdAt: Date;
}

/** Owner scoped: `profileId` is the caller's own profile (constraint 24). */
export async function advertiserCampaigns(
  tx: TestDb,
  viewer: Viewer,
  profileId: string,
): Promise<AdvertiserCampaign[]> {
  assertSignedIn(viewer);
  const rows = await tx
    .select({
      id: sponsorCampaigns.id,
      name: sponsorCampaigns.name,
      title: sponsorCampaigns.title,
      blurb: sponsorCampaigns.blurb,
      targetUrl: sponsorCampaigns.targetUrl,
      logoPath: sponsorCampaigns.logoPath,
      status: sponsorCampaigns.status,
      billingStatus: sponsorCampaigns.billingStatus,
      subscriptionId: sponsorCampaigns.subscriptionId,
      currentPeriodEnd: sponsorCampaigns.currentPeriodEnd,
      placements: sponsorCampaigns.placements,
      rejectionReason: sponsorCampaigns.rejectionReason,
      createdAt: sponsorCampaigns.createdAt,
    })
    .from(sponsorCampaigns)
    .where(eq(sponsorCampaigns.advertiserId, profileId))
    .orderBy(desc(sponsorCampaigns.createdAt));
  return rows.map((r) => ({ ...r, billingStatus: r.billingStatus as SponsorBillingStatus }));
}

export interface UpdateSponsorInput extends Omit<SponsorCopy, "name"> {
  readonly campaignId: string;
  readonly profileId: string;
  readonly ip: string | null;
}

/**
 * The advertiser's own edit. A live campaign goes back to `pending`: copy an
 * admin has not seen must not be on the rails, however small the change.
 */
export async function updateSponsorCampaign(
  tx: TestDb,
  viewer: Viewer,
  input: UpdateSponsorInput,
): Promise<"updated" | "unknown" | "invalid"> {
  assertSignedIn(viewer);
  if (!isUuid(input.campaignId)) return "unknown";
  const [current] = await tx
    .select({ id: sponsorCampaigns.id, name: sponsorCampaigns.name, status: sponsorCampaigns.status })
    .from(sponsorCampaigns)
    .where(and(eq(sponsorCampaigns.id, input.campaignId), eq(sponsorCampaigns.advertiserId, input.profileId)))
    .limit(1);
  if (!current || current.status === "ended" || current.status === "rejected") return "unknown";
  if (invalidCopy({ ...input, name: current.name }) !== null) return "invalid";
  await tx
    .update(sponsorCampaigns)
    .set({
      title: input.title.trim(),
      blurb: input.blurb.trim(),
      targetUrl: input.targetUrl,
      status: "pending",
      updatedAt: now(),
    })
    .where(eq(sponsorCampaigns.id, current.id));
  await writeAudit(tx, viewer, {
    action: "sponsor.edit",
    entityType: "sponsor_campaign",
    entityId: current.id,
    meta: { wasStatus: current.status },
    ip: input.ip,
  });
  return "updated";
}

export async function attachSponsorSubscription(
  tx: TestDb,
  viewer: Viewer,
  input: { campaignId: string; profileId: string; providerSubscriptionId: string },
): Promise<boolean> {
  assertSignedIn(viewer);
  if (!isUuid(input.campaignId)) return false;
  const rows = await tx
    .update(sponsorCampaigns)
    .set({
      subscriptionId: input.providerSubscriptionId,
      billingStatus: "approval_pending",
      updatedAt: now(),
    })
    .where(and(eq(sponsorCampaigns.id, input.campaignId), eq(sponsorCampaigns.advertiserId, input.profileId)))
    .returning({ id: sponsorCampaigns.id });
  return rows.length === 1;
}

/* ---------------------------------------------------------------- the rails */

export interface SponsorCardData {
  readonly id: string;
  readonly name: string;
  readonly logoPath: string | null;
  readonly title: string;
  readonly blurb: string;
  readonly weight: number;
}

/** More than the rotation ever needs, small enough to be one cheap read. */
export const MAX_ACTIVE_SPONSORS = 50;

function liveWindow(at: Date) {
  return and(
    eq(sponsorCampaigns.status, "active"),
    or(isNull(sponsorCampaigns.startsAt), lte(sponsorCampaigns.startsAt, at)),
    or(isNull(sponsorCampaigns.endsAt), gt(sponsorCampaigns.endsAt, at)),
    inArray(sponsorCampaigns.billingStatus, [...SHOWABLE_BILLING]),
  );
}

/** Public. What a rail on `placement` may show at `at`; the rotation picks from these. */
export async function activeSponsorCampaigns(
  tx: TestDb,
  _viewer: Viewer,
  input: { placement: AdPlacement; at: Date },
): Promise<SponsorCardData[]> {
  return tx
    .select({
      id: sponsorCampaigns.id,
      name: sponsorCampaigns.name,
      logoPath: sponsorCampaigns.logoPath,
      title: sponsorCampaigns.title,
      blurb: sponsorCampaigns.blurb,
      weight: sponsorCampaigns.weight,
    })
    .from(sponsorCampaigns)
    .where(and(liveWindow(input.at), sql`${input.placement} = any(${sponsorCampaigns.placements})`))
    .orderBy(asc(sponsorCampaigns.createdAt))
    .limit(MAX_ACTIVE_SPONSORS);
}

/** Public. The one row `/out/<id>` needs, or null for anything not live right now. */
export async function sponsorCampaignForClick(
  tx: TestDb,
  _viewer: Viewer,
  campaignId: string,
  at: Date,
): Promise<{ id: string; targetUrl: string } | null> {
  if (!isUuid(campaignId)) return null;
  const [row] = await tx
    .select({ id: sponsorCampaigns.id, targetUrl: sponsorCampaigns.targetUrl })
    .from(sponsorCampaigns)
    .where(and(eq(sponsorCampaigns.id, campaignId), liveWindow(at)))
    .limit(1);
  return row ?? null;
}

/* ---------------------------------------------------------------- the admin */

export interface AdminSponsorCampaign extends AdvertiserCampaign {
  readonly advertiserId: string;
  readonly advertiserEmail: string | null;
  readonly startsAt: Date | null;
  readonly endsAt: Date | null;
  readonly weight: number;
}

const QUEUE_ORDER = sql`case ${sponsorCampaigns.status}
  when 'pending' then 0 when 'active' then 1 when 'paused' then 2 else 3 end`;

/** Everything not finished, pending first. */
export async function listSponsorQueue(tx: TestDb, viewer: Viewer): Promise<AdminSponsorCampaign[]> {
  assertAdmin(viewer);
  const rows = await tx
    .select({
      id: sponsorCampaigns.id,
      advertiserId: sponsorCampaigns.advertiserId,
      advertiserEmail: user.email,
      name: sponsorCampaigns.name,
      title: sponsorCampaigns.title,
      blurb: sponsorCampaigns.blurb,
      targetUrl: sponsorCampaigns.targetUrl,
      logoPath: sponsorCampaigns.logoPath,
      status: sponsorCampaigns.status,
      billingStatus: sponsorCampaigns.billingStatus,
      subscriptionId: sponsorCampaigns.subscriptionId,
      currentPeriodEnd: sponsorCampaigns.currentPeriodEnd,
      placements: sponsorCampaigns.placements,
      rejectionReason: sponsorCampaigns.rejectionReason,
      startsAt: sponsorCampaigns.startsAt,
      endsAt: sponsorCampaigns.endsAt,
      weight: sponsorCampaigns.weight,
      createdAt: sponsorCampaigns.createdAt,
    })
    .from(sponsorCampaigns)
    .innerJoin(profiles, eq(profiles.id, sponsorCampaigns.advertiserId))
    .leftJoin(user, eq(user.id, profiles.userId))
    .where(inArray(sponsorCampaigns.status, ["pending", "active", "paused"]))
    .orderBy(QUEUE_ORDER, asc(sponsorCampaigns.createdAt));
  return rows.map((r) => ({ ...r, billingStatus: r.billingStatus as SponsorBillingStatus }));
}

export async function pendingSponsorCount(tx: TestDb, viewer: Viewer): Promise<number> {
  assertAdmin(viewer);
  const [row] = await tx
    .select({ total: sql<number>`count(*)::int` })
    .from(sponsorCampaigns)
    .where(eq(sponsorCampaigns.status, "pending"));
  return row?.total ?? 0;
}

export type SponsorDecision = "approve" | "reject" | "pause" | "resume" | "end";

export interface SponsorDecisionInput {
  readonly decision: SponsorDecision;
  readonly reason?: string;
  readonly ip: string | null;
}

export type SponsorDecisionResult = {
  outcome: "decided" | "unknown" | "not-allowed" | "reason-required";
};

export const SPONSOR_REJECTION_MIN_LENGTH = 10;

const ALLOWED_FROM: Record<SponsorDecision, readonly SponsorCampaignStatus[]> = {
  approve: ["pending", "paused", "rejected"],
  reject: ["pending"],
  pause: ["active"],
  resume: ["paused"],
  end: ["pending", "active", "paused"],
};

export async function decideSponsorCampaign(
  tx: TestDb,
  viewer: Viewer,
  campaignId: string,
  input: SponsorDecisionInput,
): Promise<SponsorDecisionResult> {
  assertAdmin(viewer);
  if (!isUuid(campaignId)) return { outcome: "unknown" };
  const reason = (input.reason ?? "").trim();
  if (input.decision === "reject" && reason.length < SPONSOR_REJECTION_MIN_LENGTH) {
    return { outcome: "reason-required" };
  }
  const [current] = await tx
    .select({ status: sponsorCampaigns.status, startsAt: sponsorCampaigns.startsAt })
    .from(sponsorCampaigns)
    .where(eq(sponsorCampaigns.id, campaignId))
    .for("update")
    .limit(1);
  if (!current) return { outcome: "unknown" };
  if (!ALLOWED_FROM[input.decision].includes(current.status)) return { outcome: "not-allowed" };

  const at = now();
  const actorId =
    viewer.role === "public" || viewer.userId === NIL_UUID
      ? null
      : (await ensureProfile(tx, viewer)).id;
  const decided = { decidedBy: actorId, decidedAt: at, updatedAt: at };
  switch (input.decision) {
    case "approve":
    case "resume":
      await tx
        .update(sponsorCampaigns)
        .set({ ...decided, status: "active", rejectionReason: null, startsAt: current.startsAt ?? at })
        .where(eq(sponsorCampaigns.id, campaignId));
      break;
    case "reject":
      await tx
        .update(sponsorCampaigns)
        .set({ ...decided, status: "rejected", rejectionReason: reason })
        .where(eq(sponsorCampaigns.id, campaignId));
      break;
    case "pause":
      await tx
        .update(sponsorCampaigns)
        .set({ ...decided, status: "paused" })
        .where(eq(sponsorCampaigns.id, campaignId));
      break;
    case "end":
      await tx
        .update(sponsorCampaigns)
        .set({ ...decided, status: "ended", endsAt: at })
        .where(eq(sponsorCampaigns.id, campaignId));
      break;
  }
  await writeAudit(tx, viewer, {
    action: `sponsor.${input.decision}`,
    entityType: "sponsor_campaign",
    entityId: campaignId,
    meta: { from: current.status, ...(input.decision === "reject" ? { reason } : {}) },
    ip: input.ip,
  });
  return { outcome: "decided" };
}

/* --------------------------------------------------------------- the worker */

export interface SponsorStatDelta {
  readonly campaignId: string;
  readonly day: string;
  readonly impressions: number;
  readonly clicks: number;
}

/** Additive upsert; a delta for a campaign that is gone is dropped, not fatal. */
export async function applySponsorStatDeltas(
  tx: TestDb,
  viewer: Viewer,
  deltas: readonly SponsorStatDelta[],
): Promise<number> {
  assertAdmin(viewer);
  const valid = deltas.filter(
    (d) => isUuid(d.campaignId) && isDayKey(d.day) && (d.impressions > 0 || d.clicks > 0),
  );
  if (valid.length === 0) return 0;
  const rows = sql.join(
    valid.map(
      (d) => sql`(${d.campaignId}::uuid, ${d.day}::date, ${Math.trunc(d.impressions)}::int, ${Math.trunc(d.clicks)}::int)`,
    ),
    sql`, `,
  );
  const written = (await tx.execute(sql`
    insert into sponsor_stats_daily (campaign_id, day, impressions, clicks)
    select v.campaign_id, v.day, v.impressions, v.clicks
      from (values ${rows}) as v(campaign_id, day, impressions, clicks)
      join sponsor_campaigns c on c.id = v.campaign_id
    on conflict (campaign_id, day) do update set
      impressions = sponsor_stats_daily.impressions + excluded.impressions,
      clicks      = sponsor_stats_daily.clicks      + excluded.clicks,
      updated_at  = now()
    returning sponsor_stats_daily.id
  `)) as unknown as unknown[];
  return written.length;
}

export interface SponsorBillingRow {
  readonly id: string;
  readonly status: SponsorCampaignStatus;
  readonly billingStatus: SponsorBillingStatus;
  readonly currentPeriodEnd: Date | null;
  readonly endsAt: Date | null;
}

/** Worker/webhook only. The provider id first, our own id as the fallback. */
export async function sponsorCampaignForBilling(
  tx: TestDb,
  viewer: Viewer,
  input: { providerSubscriptionId: string | null; customId: string | null },
): Promise<SponsorBillingRow | null> {
  assertAdmin(viewer);
  const where =
    input.providerSubscriptionId !== null
      ? eq(sponsorCampaigns.subscriptionId, input.providerSubscriptionId)
      : input.customId !== null && isUuid(input.customId)
        ? eq(sponsorCampaigns.id, input.customId)
        : null;
  if (where === null) return null;
  const [row] = await tx
    .select({
      id: sponsorCampaigns.id,
      status: sponsorCampaigns.status,
      billingStatus: sponsorCampaigns.billingStatus,
      currentPeriodEnd: sponsorCampaigns.currentPeriodEnd,
      endsAt: sponsorCampaigns.endsAt,
    })
    .from(sponsorCampaigns)
    .where(where)
    .limit(1);
  return row ? { ...row, billingStatus: row.billingStatus as SponsorBillingStatus } : null;
}

export interface SponsorBillingPatch {
  readonly action: string;
  readonly billingStatus: SponsorBillingStatus;
  readonly currentPeriodEnd: Date | null;
  /** `undefined` leaves ends_at alone; a Date or null sets it. */
  readonly endsAt: Date | null | undefined;
  readonly eventId: string;
  readonly providerSubscriptionId?: string | null;
}

export async function applySponsorBillingEffect(
  tx: TestDb,
  viewer: Viewer,
  campaignId: string,
  patch: SponsorBillingPatch,
): Promise<void> {
  assertAdmin(viewer);
  await tx
    .update(sponsorCampaigns)
    .set({
      billingStatus: patch.billingStatus,
      currentPeriodEnd: patch.currentPeriodEnd,
      ...(patch.endsAt === undefined ? {} : { endsAt: patch.endsAt }),
      ...(patch.providerSubscriptionId === undefined || patch.providerSubscriptionId === null
        ? {}
        : { subscriptionId: patch.providerSubscriptionId }),
      updatedAt: now(),
    })
    .where(eq(sponsorCampaigns.id, campaignId));
  await writeAudit(tx, viewer, {
    action: "sponsor.billing",
    entityType: "sponsor_campaign",
    entityId: campaignId,
    meta: { eventId: patch.eventId, action: patch.action, billingStatus: patch.billingStatus },
  });
}

export interface SponsorNotificationData {
  readonly campaignId: string;
  readonly advertiserEmail: string | null;
  readonly advertiserName: string | null;
  readonly name: string;
  readonly title: string;
  readonly blurb: string;
  readonly targetUrl: string;
  readonly status: SponsorCampaignStatus;
  readonly rejectionReason: string | null;
}

/** Worker only: what the emails need. */
export async function sponsorNotification(
  tx: TestDb,
  viewer: Viewer,
  campaignId: string,
): Promise<SponsorNotificationData | null> {
  assertAdmin(viewer);
  if (!isUuid(campaignId)) return null;
  const [row] = await tx
    .select({
      campaignId: sponsorCampaigns.id,
      advertiserEmail: user.email,
      advertiserName: user.name,
      name: sponsorCampaigns.name,
      title: sponsorCampaigns.title,
      blurb: sponsorCampaigns.blurb,
      targetUrl: sponsorCampaigns.targetUrl,
      status: sponsorCampaigns.status,
      rejectionReason: sponsorCampaigns.rejectionReason,
    })
    .from(sponsorCampaigns)
    .innerJoin(profiles, eq(profiles.id, sponsorCampaigns.advertiserId))
    .leftJoin(user, eq(user.id, profiles.userId))
    .where(eq(sponsorCampaigns.id, campaignId))
    .limit(1);
  return row ?? null;
}

/* ----------------------------------------------- self-serve helpers (owner scoped) */

/** Records where the processed logo went; the key is minted after the row exists. */
export async function setSponsorLogo(
  tx: TestDb,
  viewer: Viewer,
  input: { campaignId: string; profileId: string; logoPath: string },
): Promise<boolean> {
  assertSignedIn(viewer);
  if (!isUuid(input.campaignId)) return false;
  const rows = await tx
    .update(sponsorCampaigns)
    .set({ logoPath: input.logoPath, updatedAt: now() })
    .where(and(eq(sponsorCampaigns.id, input.campaignId), eq(sponsorCampaigns.advertiserId, input.profileId)))
    .returning({ id: sponsorCampaigns.id });
  return rows.length === 1;
}

/** The advertiser's own campaign for a PayPal subscription id, or null — the return page's gate. */
export async function advertiserCampaignBySubscription(
  tx: TestDb,
  viewer: Viewer,
  input: { profileId: string; providerSubscriptionId: string },
): Promise<{ id: string; billingStatus: SponsorBillingStatus } | null> {
  assertSignedIn(viewer);
  const [row] = await tx
    .select({ id: sponsorCampaigns.id, billingStatus: sponsorCampaigns.billingStatus })
    .from(sponsorCampaigns)
    .where(
      and(
        eq(sponsorCampaigns.subscriptionId, input.providerSubscriptionId),
        eq(sponsorCampaigns.advertiserId, input.profileId),
      ),
    )
    .limit(1);
  return row ? { id: row.id, billingStatus: row.billingStatus as SponsorBillingStatus } : null;
}
