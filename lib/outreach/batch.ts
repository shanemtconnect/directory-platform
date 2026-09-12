import { siteUrl } from "@/lib/schema/builders";
import { now } from "@/lib/clock";
import { isAdmin, type Viewer } from "@/lib/db/viewer";
import { outreachCandidates, createOutreachCampaign } from "@/lib/db/queries/outreach";
import { createOutreachCoupons } from "./coupons";
import { magicToken } from "./tokens";
import { describeSegment, type Segment } from "./segment";
import type { OutreachRow } from "./csv";
import type { TestDb } from "@/test/db";

/**
 * One claim-outreach batch, end to end: pick the businesses, mint a token and
 * a single-use coupon for each, record the campaign, hand back the rows.
 *
 * Nothing is sent. The output is a file (see ./csv.ts) for an outreach-capable
 * provider, and the campaign stays `draft` until something else stamps it.
 */

export const OUTREACH_TEMPLATE_KEY = "outreach-claim";

/** Long enough to survive a printed letter and a fortnight's inaction. */
export const COUPON_VALID_DAYS = 60;

export interface BuildOutreachBatchInput {
  segment: Segment;
  limit: number;
  couponPercent: number;
  /** Defaults to the segment plus today's date. */
  name?: string;
  /** `profiles.id` of the operator, never `viewer.userId` (constraint 21). */
  actorProfileId?: string | null;
}

export interface OutreachBatch {
  /** Null when the segment matched nobody — nothing is written in that case. */
  campaignId: string | null;
  batchId: string | null;
  rows: OutreachRow[];
}

export function outreachMagicUrl(token: string): string {
  return siteUrl(`/claim/outreach/${encodeURIComponent(token)}`);
}

export async function buildOutreachBatch(
  tx: TestDb,
  viewer: Viewer,
  input: BuildOutreachBatchInput,
): Promise<OutreachBatch> {
  if (!isAdmin(viewer)) throw new Error("FORBIDDEN");

  const candidates = await outreachCandidates(tx, viewer, {
    segment: input.segment,
    limit: input.limit,
  });
  // No candidates, no campaign and no coupons: an empty campaign row and fifty
  // unused codes are just litter for the next person reading the table.
  if (candidates.length === 0) return { campaignId: null, batchId: null, rows: [] };

  const at = now();
  const expiresAt = new Date(at.getTime() + COUPON_VALID_DAYS * 86_400_000);
  const label = describeSegment(input.segment);

  // Minted for the candidates we actually have, never for the limit.
  const batch = await createOutreachCoupons(tx, viewer, {
    count: candidates.length,
    percentOff: input.couponPercent,
    expiresAt,
    description: `Claim outreach — ${label}`,
    actorProfileId: input.actorProfileId,
  });

  const tokens = candidates.map(() => magicToken());
  const campaignId = await createOutreachCampaign(tx, viewer, {
    name: input.name ?? `Claim outreach ${at.toISOString().slice(0, 10)} — ${label}`,
    segment: input.segment,
    templateKey: OUTREACH_TEMPLATE_KEY,
    actorProfileId: input.actorProfileId,
    couponBatchId: batch.batchId,
    messages: candidates.map((c, i) => ({
      listingId: c.listingId,
      toAddress: c.email,
      magicToken: tokens[i]!,
    })),
  });

  return {
    campaignId,
    batchId: batch.batchId,
    rows: candidates.map((c, i) => ({
      address: c.email,
      businessName: c.name,
      magicUrl: outreachMagicUrl(tokens[i]!),
      couponCode: batch.codes[i]!,
    })),
  };
}
