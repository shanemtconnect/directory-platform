import { and, eq, isNull, sql, type SQL } from "drizzle-orm";
import { hashToken } from "@/lib/security/token-hash";
import {
  auditLog,
  campaignMessages,
  campaigns,
  categories,
  cities,
  listings,
} from "@/lib/db/schema";
import { now } from "@/lib/clock";
import { isAdmin, type Viewer } from "@/lib/db/viewer";
import type { Segment } from "@/lib/outreach/segment";
import type { TestDb } from "@/lib/db/types";

/**
 * Who a claim-outreach batch may contact, and what happened to it.
 *
 * Two guardrails are non-negotiable here, and both are enforced in SQL rather
 * than in the script that calls this:
 *
 *  - `unsubscribes` — one unsubscribe is one unsubscribe for ever, across
 *    every campaign. It is keyed on the normalised address, so a feed that
 *    supplies "Owner@Gone.example" does not get round it.
 *  - `suppressions` — a removal request must never be undone by a mailshot.
 *    The match is the importer's (lib/import/guardrails.ts): normalised name
 *    plus postcode, or name plus a contact point when there is no postcode.
 *    Name alone is deliberately not enough — two unrelated businesses share a
 *    name often enough that suppressing both is its own harm.
 *
 * A listing that has been in ANY campaign is also out. Emailing the same
 * unclaimed business every time somebody runs the script is how a directory
 * earns a spam complaint.
 */

function forbid(): never {
  throw new Error("FORBIDDEN");
}

/** `normaliseName` from the importer, in SQL, so both agree on identity. */
const normalisedName = (column: SQL | typeof listings.name): SQL =>
  sql`lower(regexp_replace(trim(${column}), '\\s+', ' ', 'g'))`;

const normalisedEmail = (column: typeof listings.email): SQL =>
  sql`lower(trim(${column}))`;

export interface OutreachCandidate {
  listingId: string;
  name: string;
  email: string;
  citySlug: string;
  cityName: string;
}

export async function outreachCandidates(
  tx: TestDb,
  viewer: Viewer,
  opts: { segment: Segment; limit: number },
): Promise<OutreachCandidate[]> {
  if (!isAdmin(viewer)) forbid();

  const where: SQL[] = [
    eq(listings.status, "published"),
    eq(listings.claimStatus, "unclaimed"),
    sql`coalesce(trim(${listings.email}), '') <> ''`,
    sql`not exists (
      select 1 from unsubscribes u
      where u.address_normalised = ${normalisedEmail(listings.email)}
    )`,
    sql`not exists (
      select 1 from suppressions s
      where s.name_normalised = ${normalisedName(listings.name)}
        and (
          (
            s.postcode_normalised is not null
            and ${listings.postcode} is not null
            and s.postcode_normalised = lower(regexp_replace(${listings.postcode}, '[\\s-]+', '', 'g'))
          )
          or (
            s.email is not null
            and lower(trim(s.email)) = ${normalisedEmail(listings.email)}
          )
          or (
            s.phone is not null
            and ${listings.phone} is not null
            and regexp_replace(s.phone, '[^0-9]', '', 'g')
              = regexp_replace(${listings.phone}, '[^0-9]', '', 'g')
          )
        )
    )`,
    sql`not exists (
      select 1 from campaign_messages m where m.listing_id = ${listings.id}
    )`,
  ];

  if (opts.segment.city !== undefined) where.push(eq(cities.slug, opts.segment.city));
  if (opts.segment.category !== undefined) {
    where.push(eq(categories.slug, opts.segment.category));
  }

  const rows = await tx
    .select({
      listingId: listings.id,
      name: listings.name,
      email: listings.email,
      citySlug: cities.slug,
      cityName: cities.name,
    })
    .from(listings)
    .innerJoin(cities, eq(cities.id, listings.cityId))
    .innerJoin(categories, eq(categories.id, listings.primaryCategoryId))
    .where(and(...where))
    // Stable, so re-running a batch that failed halfway produces the same file.
    .orderBy(listings.name, listings.id)
    .limit(opts.limit);

  return rows.map((r) => ({ ...r, email: r.email!.trim() }));
}

export interface OutreachMessageInput {
  listingId: string;
  toAddress: string;
  /**
   * The RAW token, null for a channel that carries no magic link. Unique when
   * present. Stored as its digest (lib/security/token-hash.ts): the raw token
   * belongs in the file that goes to the sender and nowhere in this database.
   */
  magicToken: string | null;
}

export interface CreateOutreachCampaignInput {
  name: string;
  segment: Segment;
  templateKey?: string;
  messages: OutreachMessageInput[];
  /** `profiles.id` of the operator, never `viewer.userId` (constraint 21). */
  actorProfileId?: string | null;
  couponBatchId?: string | null;
}

/**
 * The campaign row is created as `draft` and `sent_at` is left null on every
 * message: this codebase does not send them. Whatever does the sending stamps
 * those, and until then the batch is a file and a set of unused tokens.
 */
export async function createOutreachCampaign(
  tx: TestDb,
  viewer: Viewer,
  input: CreateOutreachCampaignInput,
): Promise<string> {
  if (!isAdmin(viewer)) forbid();

  const [campaign] = await tx
    .insert(campaigns)
    .values({
      name: input.name,
      segment: input.segment,
      channel: "email",
      templateKey: input.templateKey ?? null,
      status: "draft",
    })
    .returning({ id: campaigns.id });
  const campaignId = campaign!.id;

  if (input.messages.length > 0) {
    await tx.insert(campaignMessages).values(
      input.messages.map((m) => ({
        campaignId,
        listingId: m.listingId,
        toAddress: m.toAddress,
        magicToken: m.magicToken === null ? null : hashToken(m.magicToken),
      })),
    );
  }

  // Constraint 22: an admin mutation, audited in the same transaction.
  await tx.insert(auditLog).values({
    actorId: input.actorProfileId ?? null,
    action: "outreach.campaign.create",
    entityType: "campaign",
    entityId: campaignId,
    meta: {
      segment: input.segment,
      messages: input.messages.length,
      couponBatchId: input.couponBatchId ?? null,
    },
  });

  return campaignId;
}

/**
 * Resolves a magic token and stamps the first click.
 *
 * Public on purpose: the token IS the authorisation, and the person following
 * the link has not signed in yet. It resolves only to a published listing, so
 * a link sent before a removal request cannot walk someone into claiming a
 * listing that no longer exists.
 */
export async function recordOutreachClick(
  tx: TestDb,
  _viewer: Viewer,
  token: string,
  at?: Date,
): Promise<{ listingId: string } | null> {
  const trimmed = token.trim();
  if (trimmed === "") return null;

  const [row] = await tx
    .select({
      id: campaignMessages.id,
      listingId: campaignMessages.listingId,
      clickedAt: campaignMessages.clickedAt,
    })
    .from(campaignMessages)
    .innerJoin(listings, eq(listings.id, campaignMessages.listingId))
    .where(and(eq(campaignMessages.magicToken, hashToken(trimmed)), eq(listings.status, "published")))
    .limit(1);
  if (!row) return null;

  // First click only. Overwriting would turn "when did they open it" into
  // "when did they last open it", which is a different question.
  if (row.clickedAt === null) {
    await tx
      .update(campaignMessages)
      .set({ clickedAt: at ?? now() })
      .where(and(eq(campaignMessages.id, row.id), isNull(campaignMessages.clickedAt)));
  }

  return { listingId: row.listingId };
}
