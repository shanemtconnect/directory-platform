import { randomUUID } from "node:crypto";
import { afterEach, describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { withTestDb, type TestDb } from "@/test/db";
import {
  auditLog, categories, cities, listings, profiles, quoteRecipients, quoteRequests, unsubscribes, user,
} from "@/lib/db/schema";
import { PUBLIC_VIEWER, type Viewer } from "@/lib/db/viewer";
import { makeCategoryInCity, makeListing, makeScaffold, type ListingCtx } from "@/test/factories";
import { hashToken } from "@/lib/security/token-hash";
import { resetClock, setClock } from "@/lib/clock";
import {
  QUOTE_VERIFY_TTL_HOURS,
  createEnquiryLeadRequest,
  createQuoteRequest,
  previewQuoteToken,
  expireQuoteRequests,
  quoteVerification,
  verifyQuoteToken,
  flagQuoteRequestSpam,
  listQuoteRequests,
  markQuoteOutcome,
  ownerQuoteLeads,
  quoteContactVisible,
  quoteNotification,
  selectQuoteRecipients,
  type QuoteRequestInput,
  type QuoteRequestResult,
} from "./quotes";

afterEach(() => resetClock());

/** A real account: the audit row an admin write leaves resolves its profile. */
async function makeAdmin(tx: TestDb): Promise<Viewer> {
  const userId = `u_${randomUUID()}`;
  await tx.insert(user).values({ id: userId, name: "Admin", email: `${userId}@example.com` });
  await tx.insert(profiles).values({ userId, role: "admin" });
  return { role: "admin", userId };
}

function input(ctx: ListingCtx, patch: Partial<QuoteRequestInput> = {}): QuoteRequestInput {
  return {
    cityId: ctx.cityId,
    categoryId: ctx.primaryCategoryId,
    name: "Sam Requester",
    email: "sam@example.co.uk",
    phone: "01632 970000",
    message: "Looking for somewhere for about eighty people in June, with parking.",
    ip: "198.51.100.4",
    ...patch,
  };
}

async function makeOwner(tx: TestDb, email = `${randomUUID()}@example.com`) {
  const userId = `u_${randomUUID()}`;
  await tx.insert(user).values({ id: userId, name: "Owner", email });
  const [row] = await tx.insert(profiles).values({ userId }).returning({ id: profiles.id });
  return { userId, profileId: row!.id, email, viewer: { role: "owner", userId } as Viewer };
}

/**
 * A request as the verify route leaves it: created, then its link clicked.
 * Everything downstream of the click — the worker's delivery, the owner's
 * leads page, won/lost — only ever sees verified requests.
 */
async function createVerified(
  tx: TestDb,
  ctx: ListingCtx,
  patch: Partial<QuoteRequestInput> = {},
): Promise<Extract<QuoteRequestResult, { outcome: "created" }>> {
  const created = await createQuoteRequest(tx, PUBLIC_VIEWER, input(ctx, patch));
  if (created.outcome !== "created") throw new Error(created.outcome);
  const verified = await verifyQuoteToken(tx, PUBLIC_VIEWER, created.token);
  if (verified.outcome !== "verified") throw new Error(verified.outcome);
  return created;
}

async function recipientsOf(tx: TestDb, quoteRequestId: string): Promise<string[]> {
  const rows = await tx
    .select({ listingId: quoteRecipients.listingId })
    .from(quoteRecipients)
    .where(eq(quoteRecipients.quoteRequestId, quoteRequestId));
  return rows.map((r) => r.listingId).sort();
}

describe("quoteContactVisible", () => {
  it("hides the job and the contact from the free tier only", () => {
    expect(quoteContactVisible("free")).toBe(false);
    expect(quoteContactVisible("essential")).toBe(true);
    expect(quoteContactVisible("premium")).toBe(true);
  });
});

describe("selectQuoteRecipients", () => {
  it("ranks paid and verified listings first and caps at the limit", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const free = await makeListing(tx, ctx, { email: "free@example.com" });
      const verified = await makeListing(tx, ctx, { email: "verified@example.com", claimStatus: "verified" });
      const premium = await makeListing(tx, ctx, { email: "premium@example.com", tier: "premium" });
      const essential = await makeListing(tx, ctx, { email: "essential@example.com", tier: "essential" });

      const chosen = await selectQuoteRecipients(tx, PUBLIC_VIEWER, {
        cityId: ctx.cityId, categoryId: ctx.primaryCategoryId, limit: 3,
      });

      expect(chosen.map((c) => c.listingId)).toEqual([premium, essential, verified]);
      expect(chosen.map((c) => c.listingId)).not.toContain(free);
    });
  });

  it("skips listings with no address, unpublished ones, and other towns and categories", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const withEmail = await makeListing(tx, ctx, { email: "yes@example.com" });
      await makeListing(tx, ctx, { email: null });
      await makeListing(tx, ctx, { email: "   " });
      await makeListing(tx, ctx, { email: "pending@example.com", status: "pending" });
      const otherCategory = await makeCategoryInCity(tx, ctx.verticalId, ctx.cityId, "Other Halls");
      await makeListing(tx, { ...ctx, primaryCategoryId: otherCategory }, { email: "other@example.com" });

      const chosen = await selectQuoteRecipients(tx, PUBLIC_VIEWER, {
        cityId: ctx.cityId, categoryId: ctx.primaryCategoryId, limit: 10,
      });

      expect(chosen.map((c) => c.listingId)).toEqual([withEmail]);
    });
  });

  it("writes to a claimed listing at its owner's account address", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const owner = await makeOwner(tx, "account@example.com");
      const claimed = await makeListing(tx, ctx, {
        email: "scraped@example.com", claimStatus: "claimed", ownerId: owner.profileId,
      });
      // Claimed but the account has gone: falls back to the listing's own address.
      const orphan = await makeListing(tx, ctx, { email: "orphan@example.com", claimStatus: "claimed" });

      const chosen = await selectQuoteRecipients(tx, PUBLIC_VIEWER, {
        cityId: ctx.cityId, categoryId: ctx.primaryCategoryId, limit: 10,
      });

      const byId = new Map(chosen.map((c) => [c.listingId, c.email]));
      expect(byId.get(claimed)).toBe("account@example.com");
      expect(byId.get(orphan)).toBe("orphan@example.com");
    });
  });

  it("dedupes by address and honours unsubscribes", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const first = await makeListing(tx, ctx, { email: "Shared@Example.com", tier: "premium" });
      await makeListing(tx, ctx, { email: "shared@example.com" });
      await makeListing(tx, ctx, { email: "gone@example.com", tier: "premium" });
      await tx.insert(unsubscribes).values({ addressNormalised: "gone@example.com" });
      const other = await makeListing(tx, ctx, { email: "other@example.com" });

      const chosen = await selectQuoteRecipients(tx, PUBLIC_VIEWER, {
        cityId: ctx.cityId, categoryId: ctx.primaryCategoryId, limit: 10,
      });

      expect(chosen.map((c) => c.listingId)).toEqual([first, other]);
    });
  });
});

describe("createQuoteRequest", () => {
  it("stores the request, its recipients, and an audit row carrying the ip", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const a = await makeListing(tx, ctx, { email: "a@example.com", tier: "premium" });
      const b = await makeListing(tx, ctx, { email: "b@example.com" });

      const result = await createQuoteRequest(tx, PUBLIC_VIEWER, input(ctx));
      expect(result.outcome).toBe("created");
      if (result.outcome !== "created") return;
      expect(result.recipientCount).toBe(2);

      const [row] = await tx.select().from(quoteRequests).where(eq(quoteRequests.id, result.quoteRequestId));
      expect(row).toMatchObject({
        name: "Sam Requester", email: "sam@example.co.uk", ip: "198.51.100.4", isSpam: false,
      });
      expect(row!.consentAt).not.toBeNull();
      // Held until the requester clicks: pending, with only the token's digest stored.
      expect(row).toMatchObject({ status: "pending", verifiedAt: null, source: "quote" });
      expect(result.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(row!.verifyTokenHash).toBe(hashToken(result.token));
      expect(row!.verifyTokenHash).not.toContain(result.token);
      expect(row!.verifyExpiresAt!.getTime() - row!.createdAt.getTime())
        .toBeGreaterThanOrEqual(QUOTE_VERIFY_TTL_HOURS * 3_600_000 - 5_000);
      expect(await recipientsOf(tx, result.quoteRequestId)).toEqual([a, b].sort());

      const masks = await tx
        .select({ listingId: quoteRecipients.listingId, masked: quoteRecipients.contactMasked })
        .from(quoteRecipients)
        .where(eq(quoteRecipients.quoteRequestId, result.quoteRequestId));
      expect(new Map(masks.map((m) => [m.listingId, m.masked]))).toEqual(new Map([[a, false], [b, true]]));

      const [audit] = await tx.select().from(auditLog).where(eq(auditLog.entityId, result.quoteRequestId));
      expect(audit).toMatchObject({ action: "quote.requested", entityType: "quote_request", ip: "198.51.100.4", actorId: null });
      expect((audit!.meta as { recipients: string[] }).recipients.sort()).toEqual([a, b].sort());
    });
  });

  it("caps recipients at siteConfig.quotes.maxRecipients", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      for (let i = 0; i < 8; i++) await makeListing(tx, ctx, { email: `l${i}@example.com` });

      const result = await createQuoteRequest(tx, PUBLIC_VIEWER, input(ctx));
      expect(result.outcome).toBe("created");
      if (result.outcome !== "created") return;
      expect(result.recipientCount).toBe(5);
      expect(await recipientsOf(tx, result.quoteRequestId)).toHaveLength(5);
    });
  });

  it("writes nothing when no listing can receive it", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      await makeListing(tx, ctx, { email: null });

      expect(await createQuoteRequest(tx, PUBLIC_VIEWER, input(ctx))).toEqual({ outcome: "no-recipients" });
      expect(await tx.select().from(quoteRequests)).toHaveLength(0);
    });
  });

  it("stores a request nobody can receive when the lead marketplace asks it to", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      await makeListing(tx, ctx, { email: null });

      const result = await createQuoteRequest(tx, PUBLIC_VIEWER, input(ctx), { allowNoRecipients: true });
      expect(result).toMatchObject({ outcome: "created", recipientCount: 0 });
      if (result.outcome !== "created") return;
      expect(await recipientsOf(tx, result.quoteRequestId)).toEqual([]);
    });
  });

  it("with the lead marketplace on, keeps a no-recipient request only if it can become a lead — and says why not", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      await makeListing(tx, ctx, { email: null });
      const opts = { allowNoRecipients: true };

      // No phone: the only destination is a lead, and a lead needs a number to ring.
      expect(await createQuoteRequest(tx, PUBLIC_VIEWER, input(ctx, { phone: null }), opts))
        .toEqual({ outcome: "lead-refused", reason: "phone_invalid" });
      // A fiction number, a throwaway inbox: the same, told now rather than dropped after the click.
      expect(await createQuoteRequest(tx, PUBLIC_VIEWER, input(ctx, { phone: "01632 960123" }), opts))
        .toEqual({ outcome: "lead-refused", reason: "phone_invalid" });
      expect(await createQuoteRequest(tx, PUBLIC_VIEWER, input(ctx, { email: "x@mailinator.com" }), opts))
        .toEqual({ outcome: "lead-refused", reason: "disposable_email" });
      expect(await tx.select().from(quoteRequests)).toHaveLength(0);

      // A request that DOES reach a listing is never held to the lead rules.
      await makeListing(tx, ctx, { email: "a@example.com" });
      expect((await createQuoteRequest(tx, PUBLIC_VIEWER, input(ctx, { phone: null }), opts)).outcome).toBe("created");
    });
  });

  it("stores a capture request with no recipients even where listings could receive it", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      await makeListing(tx, ctx, { email: "a@example.com", tier: "premium" });

      const result = await createQuoteRequest(tx, PUBLIC_VIEWER, input(ctx), { source: "capture" });
      expect(result).toMatchObject({ outcome: "created", recipientCount: 0 });
      if (result.outcome !== "created") return;
      expect(await recipientsOf(tx, result.quoteRequestId)).toEqual([]);
      const [row] = await tx.select().from(quoteRequests).where(eq(quoteRequests.id, result.quoteRequestId));
      expect(row).toMatchObject({ source: "capture", status: "pending" });
    });
  });

  it("refuses an unknown or unpublished town and an inactive category", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      await makeListing(tx, ctx, { email: "a@example.com" });

      expect(await createQuoteRequest(tx, PUBLIC_VIEWER, input(ctx, { cityId: "nope" }))).toEqual({ outcome: "unknown-city" });
      expect(await createQuoteRequest(tx, PUBLIC_VIEWER, input(ctx, { cityId: randomUUID() }))).toEqual({ outcome: "unknown-city" });
      expect(await createQuoteRequest(tx, PUBLIC_VIEWER, input(ctx, { categoryId: randomUUID() }))).toEqual({ outcome: "unknown-category" });

      await tx.update(categories).set({ isActive: false }).where(eq(categories.id, ctx.primaryCategoryId));
      expect(await createQuoteRequest(tx, PUBLIC_VIEWER, input(ctx))).toEqual({ outcome: "unknown-category" });

      await tx.update(categories).set({ isActive: true }).where(eq(categories.id, ctx.primaryCategoryId));
      await tx.update(cities).set({ isPublished: false }).where(eq(cities.id, ctx.cityId));
      expect(await createQuoteRequest(tx, PUBLIC_VIEWER, input(ctx))).toEqual({ outcome: "unknown-city" });
    });
  });
});

describe("quoteNotification", () => {
  it("resolves every recipient's address and flags an unsubscribe made since", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const owner = await makeOwner(tx, "account@example.com");
      const claimed = await makeListing(tx, ctx, {
        name: "Claimed Hall", email: "scraped@example.com", claimStatus: "claimed",
        ownerId: owner.profileId, tier: "essential",
      });
      const unclaimed = await makeListing(tx, ctx, { name: "Unclaimed Hall", email: "listing@example.com" });

      const created = await createVerified(tx, ctx);
      await tx.insert(unsubscribes).values({ addressNormalised: "listing@example.com" });

      const data = await quoteNotification(tx, await makeAdmin(tx), created.quoteRequestId);
      expect(data).not.toBeNull();
      expect(data!.requester).toEqual({ name: "Sam Requester", email: "sam@example.co.uk", phone: "01632 970000" });
      expect(data!.message).toContain("eighty people");
      const byId = new Map(data!.recipients.map((r) => [r.listingId, r]));
      expect(byId.get(claimed)).toMatchObject({
        email: "account@example.com", unsubscribed: false, contactVisible: true, listingName: "Claimed Hall",
      });
      expect(byId.get(unclaimed)).toMatchObject({
        email: "listing@example.com", unsubscribed: true, contactVisible: false,
      });
      expect(byId.get(unclaimed)!.path).toMatch(/^\/[a-z0-9-]+\/[a-z0-9-]+$/);
    });
  });

  it("returns null until the requester has clicked the link", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      await makeListing(tx, ctx, { email: "a@example.com" });
      const created = await createQuoteRequest(tx, PUBLIC_VIEWER, input(ctx));
      if (created.outcome !== "created") throw new Error(created.outcome);
      const ADMIN = await makeAdmin(tx);

      expect(await quoteNotification(tx, ADMIN, created.quoteRequestId)).toBeNull();
      await verifyQuoteToken(tx, PUBLIC_VIEWER, created.token);
      expect(await quoteNotification(tx, ADMIN, created.quoteRequestId)).not.toBeNull();
    });
  });

  it("is worker-only and returns null for a flagged request", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      await makeListing(tx, ctx, { email: "a@example.com" });
      const created = await createVerified(tx, ctx);

      const ADMIN = await makeAdmin(tx);
      await expect(quoteNotification(tx, PUBLIC_VIEWER, created.quoteRequestId)).rejects.toThrow("FORBIDDEN");
      expect(await quoteNotification(tx, ADMIN, "not-a-uuid")).toBeNull();

      await flagQuoteRequestSpam(tx, ADMIN, created.quoteRequestId, true, null);
      expect(await quoteNotification(tx, ADMIN, created.quoteRequestId)).toBeNull();
    });
  });
});

describe("ownerQuoteLeads", () => {
  it("shows a paid listing the job and the requester, and a free one neither", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const paid = await makeOwner(tx);
      const free = await makeOwner(tx);
      const paidListing = await makeListing(tx, ctx, { email: "p@example.com", tier: "essential", ownerId: paid.profileId, claimStatus: "claimed" });
      const freeListing = await makeListing(tx, ctx, { email: "f@example.com", ownerId: free.profileId, claimStatus: "claimed" });
      const created = await createQuoteRequest(tx, PUBLIC_VIEWER, input(ctx));
      if (created.outcome !== "created") throw new Error(created.outcome);

      // Nothing on anybody's leads page until the requester confirms.
      expect(await ownerQuoteLeads(tx, paid.viewer, paidListing)).toEqual([]);
      await verifyQuoteToken(tx, PUBLIC_VIEWER, created.token);

      const [paidLead] = await ownerQuoteLeads(tx, paid.viewer, paidListing);
      expect(paidLead).toMatchObject({
        contactVisible: true,
        outcome: "open",
        job: input(ctx).message,
        requester: { name: "Sam Requester", email: "sam@example.co.uk", phone: "01632 970000" },
      });

      const [freeLead] = await ownerQuoteLeads(tx, free.viewer, freeListing);
      expect(freeLead).toMatchObject({ contactVisible: false, job: null, requester: null });
      expect(freeLead!.cityName).toBeTruthy();
      expect(freeLead!.categoryName).toBeTruthy();

      // Somebody else's listing: nothing, not an error.
      expect(await ownerQuoteLeads(tx, free.viewer, paidListing)).toEqual([]);
      await expect(ownerQuoteLeads(tx, PUBLIC_VIEWER, paidListing)).rejects.toThrow("FORBIDDEN");
    });
  });

  it("reveals earlier requests once the listing is upgraded, and hides flagged ones", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const owner = await makeOwner(tx);
      const listingId = await makeListing(tx, ctx, { email: "f@example.com", ownerId: owner.profileId, claimStatus: "claimed" });
      const created = await createVerified(tx, ctx);

      expect((await ownerQuoteLeads(tx, owner.viewer, listingId))[0]!.job).toBeNull();

      await tx.update(listings).set({ tier: "premium" }).where(eq(listings.id, listingId));
      expect((await ownerQuoteLeads(tx, owner.viewer, listingId))[0]!.job).toContain("eighty people");

      await flagQuoteRequestSpam(tx, await makeAdmin(tx), created.quoteRequestId, true, "203.0.113.9");
      expect(await ownerQuoteLeads(tx, owner.viewer, listingId)).toEqual([]);
    });
  });
});

describe("markQuoteOutcome", () => {
  it("records won or lost for the owner of a paid listing, with an audit row", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const owner = await makeOwner(tx);
      const listingId = await makeListing(tx, ctx, { email: "p@example.com", tier: "premium", ownerId: owner.profileId, claimStatus: "claimed" });
      await createVerified(tx, ctx);
      const [lead] = await ownerQuoteLeads(tx, owner.viewer, listingId);

      expect(await markQuoteOutcome(tx, owner.viewer, lead!.id, "won", "203.0.113.9")).toBe(true);
      // A second identical click changes nothing and audits nothing.
      expect(await markQuoteOutcome(tx, owner.viewer, lead!.id, "won", "203.0.113.9")).toBe(false);
      expect(await markQuoteOutcome(tx, owner.viewer, lead!.id, "lost", "203.0.113.9")).toBe(true);

      const [after] = await ownerQuoteLeads(tx, owner.viewer, listingId);
      expect(after!.outcome).toBe("lost");
      expect(after!.outcomeAt).not.toBeNull();

      const audits = await tx.select().from(auditLog).where(eq(auditLog.entityId, lead!.id));
      expect(audits.map((a) => a.action).sort()).toEqual(["quote.marked_lost", "quote.marked_won"]);
      expect(audits[0]!.ip).toBe("203.0.113.9");
    });
  });

  it("refuses another owner, the free tier, and a malformed id", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const owner = await makeOwner(tx);
      const stranger = await makeOwner(tx);
      const listingId = await makeListing(tx, ctx, { email: "f@example.com", ownerId: owner.profileId, claimStatus: "claimed" });
      await createVerified(tx, ctx);
      const [row] = await tx.select({ id: quoteRecipients.id }).from(quoteRecipients);

      expect(await markQuoteOutcome(tx, owner.viewer, row!.id, "won", null)).toBe(false);
      expect(await markQuoteOutcome(tx, stranger.viewer, row!.id, "won", null)).toBe(false);
      expect(await markQuoteOutcome(tx, owner.viewer, "nope", "won", null)).toBe(false);
      await expect(markQuoteOutcome(tx, PUBLIC_VIEWER, row!.id, "won", null)).rejects.toThrow("FORBIDDEN");
    });
  });
});

describe("listQuoteRequests / flagQuoteRequestSpam", () => {
  it("lists newest first with counts, admin only, and flags in place", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      await makeListing(tx, ctx, { email: "a@example.com" });
      await makeListing(tx, ctx, { email: "b@example.com" });
      const first = await createQuoteRequest(tx, PUBLIC_VIEWER, input(ctx, { name: "First" }));
      const second = await createQuoteRequest(tx, PUBLIC_VIEWER, input(ctx, { name: "Second" }));
      if (first.outcome !== "created" || second.outcome !== "created") throw new Error("not created");
      // Both rows share the transaction's now(); push the first one back so the order is real.
      await tx.update(quoteRequests).set({ createdAt: new Date(Date.now() - 60_000) })
        .where(eq(quoteRequests.id, first.quoteRequestId));
      const ADMIN = await makeAdmin(tx);

      await expect(listQuoteRequests(tx, PUBLIC_VIEWER)).rejects.toThrow("FORBIDDEN");
      const rows = await listQuoteRequests(tx, ADMIN);
      expect(rows.map((r) => r.name)).toEqual(["Second", "First"]);
      expect(rows[0]).toMatchObject({ recipientCount: 2, wonCount: 0, isSpam: false, status: "pending" });

      expect(await flagQuoteRequestSpam(tx, ADMIN, first.quoteRequestId, true, "203.0.113.9")).toBe(true);
      expect(await flagQuoteRequestSpam(tx, ADMIN, first.quoteRequestId, true, "203.0.113.9")).toBe(false);
      expect((await listQuoteRequests(tx, ADMIN)).find((r) => r.id === first.quoteRequestId)!.isSpam).toBe(true);
      await expect(flagQuoteRequestSpam(tx, PUBLIC_VIEWER, first.quoteRequestId, true, null)).rejects.toThrow("FORBIDDEN");

      const [audit] = await tx.select().from(auditLog).where(eq(auditLog.action, "quote.flagged_spam"));
      expect(audit).toMatchObject({ entityId: first.quoteRequestId, ip: "203.0.113.9" });
    });
  });
});

describe("verifyQuoteToken", () => {
  it("verifies a live link once, counts it for each recipient, and audits it", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      await makeListing(tx, ctx, { email: "a@example.com" });
      await makeListing(tx, ctx, { email: "b@example.com" });
      const created = await createQuoteRequest(tx, PUBLIC_VIEWER, input(ctx));
      if (created.outcome !== "created") throw new Error(created.outcome);

      const result = await verifyQuoteToken(tx, PUBLIC_VIEWER, created.token);

      expect(result).toEqual({
        outcome: "verified", quoteRequestId: created.quoteRequestId, source: "quote", recipientCount: 2,
      });
      const [row] = await tx.select().from(quoteRequests).where(eq(quoteRequests.id, created.quoteRequestId));
      expect(row!.status).toBe("verified");
      expect(row!.verifiedAt).not.toBeNull();
      const audits = await tx.select().from(auditLog).where(eq(auditLog.entityId, created.quoteRequestId));
      expect(audits.map((a) => a.action).sort()).toEqual(["quote.requested", "quote.verified"]);
    });
  });

  it("reports a reused link as already verified and changes nothing", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      await makeListing(tx, ctx, { email: "a@example.com" });
      const created = await createVerified(tx, ctx);
      const [before] = await tx.select().from(quoteRequests).where(eq(quoteRequests.id, created.quoteRequestId));

      expect(await verifyQuoteToken(tx, PUBLIC_VIEWER, created.token))
        .toEqual({ outcome: "already-verified", quoteRequestId: created.quoteRequestId });
      const [after] = await tx.select().from(quoteRequests).where(eq(quoteRequests.id, created.quoteRequestId));
      expect(after!.verifiedAt).toEqual(before!.verifiedAt);
      const audits = await tx.select().from(auditLog).where(eq(auditLog.action, "quote.verified"));
      expect(audits.filter((a) => a.entityId === created.quoteRequestId)).toHaveLength(1);
    });
  });

  it("refuses a link older than 48 hours and marks the request expired", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      await makeListing(tx, ctx, { email: "a@example.com" });
      setClock(new Date("2026-09-25T12:00:00Z"));
      const created = await createQuoteRequest(tx, PUBLIC_VIEWER, input(ctx));
      if (created.outcome !== "created") throw new Error(created.outcome);

      setClock(new Date(Date.parse("2026-09-25T12:00:00Z") + QUOTE_VERIFY_TTL_HOURS * 3_600_000 + 1000));
      expect(await verifyQuoteToken(tx, PUBLIC_VIEWER, created.token)).toEqual({ outcome: "expired" });
      const [row] = await tx.select().from(quoteRequests).where(eq(quoteRequests.id, created.quoteRequestId));
      expect(row).toMatchObject({ status: "expired", verifiedAt: null });
      // And stays refused.
      expect(await verifyQuoteToken(tx, PUBLIC_VIEWER, created.token)).toEqual({ outcome: "expired" });
    });
  });

  it("does not recognise a made-up, empty or oversized token", async () => {
    await withTestDb(async (tx) => {
      for (const token of ["", "nope", "x".repeat(500)]) {
        expect(await verifyQuoteToken(tx, PUBLIC_VIEWER, token)).toEqual({ outcome: "unknown" });
      }
    });
  });

  it("does not verify a request an admin flagged as spam before the click", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      await makeListing(tx, ctx, { email: "a@example.com" });
      const created = await createQuoteRequest(tx, PUBLIC_VIEWER, input(ctx));
      if (created.outcome !== "created") throw new Error(created.outcome);
      await flagQuoteRequestSpam(tx, await makeAdmin(tx), created.quoteRequestId, true, null);

      expect(await verifyQuoteToken(tx, PUBLIC_VIEWER, created.token)).toEqual({ outcome: "unknown" });
    });
  });
});

describe("quoteVerification", () => {
  it("gives the worker what the verification email needs, admin only", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      await makeListing(tx, ctx, { email: "a@example.com" });
      const created = await createQuoteRequest(tx, PUBLIC_VIEWER, input(ctx));
      if (created.outcome !== "created") throw new Error(created.outcome);
      const ADMIN = await makeAdmin(tx);

      await expect(quoteVerification(tx, PUBLIC_VIEWER, created.quoteRequestId)).rejects.toThrow("FORBIDDEN");
      const data = await quoteVerification(tx, ADMIN, created.quoteRequestId);
      expect(data).toMatchObject({
        name: "Sam Requester", email: "sam@example.co.uk", status: "pending", source: "quote",
        tokenHash: hashToken(created.token),
      });
      expect(data!.cityName).toBeTruthy();
      expect(data!.categoryName).toBeTruthy();
      expect(data!.expiresAt).toBeInstanceOf(Date);
      expect(await quoteVerification(tx, ADMIN, randomUUID())).toBeNull();
    });
  });
});

describe("expireQuoteRequests", () => {
  it("expires pending requests past their link, and leaves live and verified ones", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      await makeListing(tx, ctx, { email: "a@example.com" });
      const T0 = Date.parse("2026-09-25T12:00:00Z");
      setClock(new Date(T0));
      const stale = await createQuoteRequest(tx, PUBLIC_VIEWER, input(ctx, { name: "Stale" }));
      const confirmed = await createVerified(tx, ctx, { name: "Confirmed" });
      setClock(new Date(T0 + 47 * 3_600_000));
      const fresh = await createQuoteRequest(tx, PUBLIC_VIEWER, input(ctx, { name: "Fresh" }));
      if (stale.outcome !== "created" || fresh.outcome !== "created") throw new Error("not created");
      const ADMIN = await makeAdmin(tx);

      setClock(new Date(T0 + QUOTE_VERIFY_TTL_HOURS * 3_600_000 + 1000));
      await expect(expireQuoteRequests(tx, PUBLIC_VIEWER)).rejects.toThrow("FORBIDDEN");
      expect(await expireQuoteRequests(tx, ADMIN)).toBe(1);

      const statusOf = async (id: string) =>
        (await tx.select({ s: quoteRequests.status }).from(quoteRequests).where(eq(quoteRequests.id, id)))[0]!.s;
      expect(await statusOf(stale.quoteRequestId)).toBe("expired");
      expect(await statusOf(confirmed.quoteRequestId)).toBe("verified");
      expect(await statusOf(fresh.quoteRequestId)).toBe("pending");
      expect(await expireQuoteRequests(tx, ADMIN)).toBe(0);
    });
  });

  it("expires a pending row with no link (old code, mid-deploy) 48 hours after it was created", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const T0 = Date.parse("2026-09-25T12:00:00Z");
      const [legacy] = await tx.insert(quoteRequests).values({
        name: "Legacy", email: "legacy@example.co.uk", message: "Written by the old code", cityId: ctx.cityId,
        categoryId: ctx.primaryCategoryId, createdAt: new Date(T0), updatedAt: new Date(T0),
      }).returning({ id: quoteRequests.id, status: quoteRequests.status, expires: quoteRequests.verifyExpiresAt });
      expect(legacy).toMatchObject({ status: "pending", expires: null });
      const ADMIN = await makeAdmin(tx);

      setClock(new Date(T0 + (QUOTE_VERIFY_TTL_HOURS - 1) * 3_600_000));
      expect(await expireQuoteRequests(tx, ADMIN)).toBe(0);
      setClock(new Date(T0 + QUOTE_VERIFY_TTL_HOURS * 3_600_000 + 1000));
      expect(await expireQuoteRequests(tx, ADMIN)).toBe(1);
      const [row] = await tx.select({ s: quoteRequests.status }).from(quoteRequests).where(eq(quoteRequests.id, legacy!.id));
      expect(row!.s).toBe("expired");
    });
  });
});

describe("free at submit, upgraded before the click", () => {
  it("makes no lead: the paying local keeps its free quote (D5 reads the tier at the click)", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const listingId = await makeListing(tx, ctx, { email: "free@example.com" });
      const created = await createQuoteRequest(tx, PUBLIC_VIEWER, input(ctx, { email: `up-${randomUUID()}@example.co.uk` }));
      if (created.outcome !== "created") throw new Error(created.outcome);

      await tx.update(listings).set({ tier: "essential" }).where(eq(listings.id, listingId));
      await verifyQuoteToken(tx, PUBLIC_VIEWER, created.token);

      const { createLeadFromQuote } = await import("./leads");
      expect(await createLeadFromQuote(tx, PUBLIC_VIEWER, created.quoteRequestId)).toBeNull();

      // …whereas one still free at the click does make one.
      await tx.update(listings).set({ tier: "free" }).where(eq(listings.id, listingId));
      expect((await createLeadFromQuote(tx, PUBLIC_VIEWER, created.quoteRequestId))?.status).toBe("open");
    });
  });
});

describe("previewQuoteToken", () => {
  it("reports a link's state and never spends it", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      await makeListing(tx, ctx, { email: "a@example.com" });
      const T0 = Date.parse("2026-09-25T12:00:00Z");
      setClock(new Date(T0));
      const created = await createQuoteRequest(tx, PUBLIC_VIEWER, input(ctx));
      if (created.outcome !== "created") throw new Error(created.outcome);

      // Twice, as a scanner and then the person would: still live, still pending.
      expect(await previewQuoteToken(tx, PUBLIC_VIEWER, created.token)).toEqual({ outcome: "live", source: "quote" });
      expect(await previewQuoteToken(tx, PUBLIC_VIEWER, created.token)).toEqual({ outcome: "live", source: "quote" });
      const [row] = await tx.select().from(quoteRequests).where(eq(quoteRequests.id, created.quoteRequestId));
      expect(row).toMatchObject({ status: "pending", verifiedAt: null });

      expect(await previewQuoteToken(tx, PUBLIC_VIEWER, "made-up")).toEqual({ outcome: "unknown" });
      setClock(new Date(T0 + QUOTE_VERIFY_TTL_HOURS * 3_600_000 + 1000));
      expect(await previewQuoteToken(tx, PUBLIC_VIEWER, created.token)).toEqual({ outcome: "expired" });
      setClock(new Date(T0));
      await verifyQuoteToken(tx, PUBLIC_VIEWER, created.token);
      expect(await previewQuoteToken(tx, PUBLIC_VIEWER, created.token)).toEqual({ outcome: "already-verified" });
    });
  });
});

describe("createEnquiryLeadRequest", () => {
  it("holds an enquirer's verification link against the listing, with no recipients, off the admin quote list", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const listingId = await makeListing(tx, ctx, { name: "Quiet Hall", email: null });
      const created = await createEnquiryLeadRequest(tx, PUBLIC_VIEWER, {
        listingId, cityId: ctx.cityId, categoryId: null, name: "Jo Enquirer", email: "jo@example.co.uk",
        phone: "01632 970123", message: "Is the hall free on 3 May?", ip: "198.51.100.4",
      });

      const [row] = await tx.select().from(quoteRequests).where(eq(quoteRequests.id, created.quoteRequestId));
      expect(row).toMatchObject({ source: "enquiry", status: "pending", listingId, categoryId: null });
      expect(row!.verifyTokenHash).toBe(hashToken(created.token));
      expect(await recipientsOf(tx, created.quoteRequestId)).toEqual([]);

      const ADMIN = await makeAdmin(tx);
      expect(await quoteVerification(tx, ADMIN, created.quoteRequestId)).toMatchObject({
        source: "enquiry", listingName: "Quiet Hall", categoryName: null, status: "pending",
      });
      expect((await listQuoteRequests(tx, ADMIN)).map((r) => r.id)).not.toContain(created.quoteRequestId);

      expect(await previewQuoteToken(tx, PUBLIC_VIEWER, created.token)).toEqual({ outcome: "live", source: "enquiry" });
      expect(await verifyQuoteToken(tx, PUBLIC_VIEWER, created.token)).toEqual({
        outcome: "verified", quoteRequestId: created.quoteRequestId, source: "enquiry", recipientCount: 0,
      });
    });
  });
});
