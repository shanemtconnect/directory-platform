import { randomUUID } from "node:crypto";
import { coupons } from "@/lib/db/schema";
import { isAdmin, type Viewer } from "@/lib/db/viewer";
import { couponCode } from "./tokens";
import type { TestDb } from "@/test/db";

/**
 * The single-use codes a claim-outreach batch carries.
 *
 * Every row is `max_redemptions: 1`. A shared code on a printed letter is one
 * screenshot away from a deals site, and then every subscription sold that
 * month is discounted. One code per recipient also makes the batch's
 * conversion measurable without a tracking pixel.
 *
 * `batch_id` is what groups a run, so fifty codes export — and can later be
 * revoked — together.
 *
 * Rows are inserted here directly rather than through the billing coupon
 * module: this is a bulk generator with no redemption logic, and the insert
 * shape is exactly `lib/db/schema/money.ts`.
 */

export interface CreateOutreachCouponsInput {
  count: number;
  /** 1–100. Percent, because a fixed amount cannot be currency-neutral. */
  percentOff: number;
  expiresAt?: Date;
  description?: string;
  /** `profiles.id` of the operator, never `viewer.userId` (constraint 21). */
  actorProfileId?: string | null;
  /** Test seam. `attempt` rises on a code collision. */
  codeFor?: (index: number, attempt: number) => string;
}

export interface OutreachCouponBatch {
  batchId: string;
  codes: string[];
}

/** Collisions are ~1 in 10^9; ten attempts is a generous ceiling on bad luck. */
const MAX_CODE_ATTEMPTS = 10;

export async function createOutreachCoupons(
  tx: TestDb,
  viewer: Viewer,
  input: CreateOutreachCouponsInput,
): Promise<OutreachCouponBatch> {
  if (!isAdmin(viewer)) throw new Error("FORBIDDEN");
  if (!Number.isFinite(input.percentOff) || input.percentOff <= 0 || input.percentOff > 100) {
    throw new Error(`Coupon percent must be between 1 and 100, got ${input.percentOff}`);
  }

  const batchId = randomUUID();
  const prefix = `SAVE${Math.round(input.percentOff)}`;
  const codeFor = input.codeFor ?? ((): string => couponCode(prefix));
  const codes: string[] = [];

  for (let i = 0; i < input.count; i++) {
    let inserted: string | null = null;
    for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS && inserted === null; attempt++) {
      const code = codeFor(i, attempt);
      // The unique index on `code` is the guarantee, not the generator. Taking
      // the conflict here rather than throwing means one unlucky code does not
      // abandon a half-written batch.
      const [row] = await tx
        .insert(coupons)
        .values({
          code,
          description: input.description ?? null,
          discountType: "percent",
          value: input.percentOff.toFixed(2),
          maxRedemptions: 1,
          startsAt: null,
          expiresAt: input.expiresAt ?? null,
          isActive: true,
          createdBy: input.actorProfileId ?? null,
          batchId,
        })
        .onConflictDoNothing({ target: coupons.code })
        .returning({ code: coupons.code });
      inserted = row?.code ?? null;
    }
    if (inserted === null) {
      throw new Error(`Could not mint a unique coupon code after ${MAX_CODE_ATTEMPTS} attempts`);
    }
    codes.push(inserted);
  }

  return { batchId, codes };
}
