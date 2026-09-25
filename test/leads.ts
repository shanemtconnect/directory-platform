import { randomUUID } from "node:crypto";
import { creditLedger, leadStandingOrders, leads, profiles, user } from "@/lib/db/schema";
import type { Territory } from "@/lib/db/schema/lead-market";
import type { Viewer } from "@/lib/db/viewer";
import { makeListing, type ListingCtx } from "./factories";
import type { TestDb } from "./db";

/**
 * Lead-market fixtures (Task 58): a buyer (account + profile + an owned,
 * published listing + credit), a lead as the confirm route leaves it, and a
 * standing order. Rows only — no rule or allocation runs here.
 */

const DAY = 86_400_000;

export interface Buyer {
  viewer: Viewer;
  authUserId: string;
  profileId: string;
  listingId: string;
  email: string;
}

export async function makeBuyer(tx: TestDb, ctx: ListingCtx, creditCents = 0): Promise<Buyer> {
  const authUserId = `u_${randomUUID()}`;
  const email = `${authUserId}@example.com`;
  await tx.insert(user).values({ id: authUserId, name: "Lead Buyer", email });
  const [p] = await tx.insert(profiles).values({ userId: authUserId, role: "owner" }).returning({ id: profiles.id });
  const listingId = await makeListing(tx, ctx, { ownerId: p!.id, claimStatus: "claimed" });
  if (creditCents > 0) await credit(tx, p!.id, creditCents);
  return { viewer: { role: "owner", userId: authUserId }, authUserId, profileId: p!.id, listingId, email };
}

export async function credit(tx: TestDb, profileId: string, cents: number): Promise<void> {
  await tx.insert(creditLedger).values({ userId: profileId, deltaCents: cents, kind: "topup", note: "test" });
}

export async function makeLead(
  tx: TestDb,
  ctx: { cityId: string; primaryCategoryId: string | null },
  patch: Partial<typeof leads.$inferInsert> = {},
  at: Date = new Date(),
): Promise<string> {
  const id = randomUUID();
  const email = `lead-${id}@example.co.uk`;
  await tx.insert(leads).values({
    id,
    source: "capture",
    cityId: ctx.cityId,
    categoryId: ctx.primaryCategoryId,
    firstName: "Sam",
    brief: "About eighty guests in June.",
    name: "Sam Requester",
    email,
    phone: "01632 970001",
    phoneNormalised: `+441632${String(Math.floor(Math.random() * 1e6)).padStart(6, "0")}`,
    emailNormalised: email,
    message: "About eighty guests in June. Call me on 01632 970001.",
    status: "open",
    priceCents: 2500,
    halfPriceAt: new Date(at.getTime() + 7 * DAY),
    expiresAt: new Date(at.getTime() + 30 * DAY),
    createdAt: at,
    updatedAt: at,
    ...patch,
  });
  return id;
}

export async function makeStandingOrder(
  tx: TestDb,
  buyer: Pick<Buyer, "profileId" | "listingId">,
  patch: Partial<typeof leadStandingOrders.$inferInsert> & { territories?: Territory[] } = {},
): Promise<string> {
  const [row] = await tx.insert(leadStandingOrders).values({
    userId: buyer.profileId,
    listingId: buyer.listingId,
    territories: [{ kind: "national" }],
    categoryIds: null,
    priceCents: 2500,
    ...patch,
  }).returning({ id: leadStandingOrders.id });
  return row!.id;
}
