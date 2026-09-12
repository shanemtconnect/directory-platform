import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { withTestDb } from "@/test/db";
import {
  auditLog,
  campaigns,
  campaignMessages,
  listings,
  suppressions,
  unsubscribes,
} from "@/lib/db/schema";
import { PUBLIC_VIEWER, type Viewer } from "@/lib/db/viewer";
import {
  makeListing,
  makeScaffold,
  makeCategoryInCity,
  makeCity,
  linkCategoryToCity,
} from "@/test/factories";
import {
  outreachCandidates,
  createOutreachCampaign,
  recordOutreachClick,
} from "./outreach";

const ADMIN: Viewer = { role: "admin", userId: "00000000-0000-4000-8000-00000000adm1" };

describe("outreachCandidates", () => {
  it("returns published, unclaimed listings that have an email", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const wanted = await makeListing(tx, ctx, {
        name: "Reachable Place",
        email: "owner@reachable.example",
      });
      await makeListing(tx, ctx, { name: "No Email Place" });
      await makeListing(tx, ctx, { name: "Blank Email", email: "   " });
      await makeListing(tx, ctx, {
        name: "Already Claimed", email: "a@b.example", claimStatus: "claimed",
      });
      await makeListing(tx, ctx, {
        name: "Verified Place", email: "c@d.example", claimStatus: "verified",
      });
      const pending = await makeListing(tx, ctx, { name: "Pending Place", email: "e@f.example" });
      await tx.update(listings).set({ status: "pending" }).where(eq(listings.id, pending));

      const rows = await outreachCandidates(tx, ADMIN, { segment: {}, limit: 50 });

      expect(rows.map((r) => r.listingId)).toEqual([wanted]);
      expect(rows[0]).toMatchObject({
        name: "Reachable Place",
        email: "owner@reachable.example",
      });
    });
  });

  it("skips an address that has unsubscribed, whatever its casing", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      await makeListing(tx, ctx, { name: "Opted Out", email: "  Owner@Gone.example " });
      await tx.insert(unsubscribes).values({ addressNormalised: "owner@gone.example" });

      expect(await outreachCandidates(tx, ADMIN, { segment: {}, limit: 50 })).toEqual([]);
    });
  });

  it("skips a suppressed business — a removal request is not undone by a mailshot", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      await makeListing(tx, ctx, {
        name: "The Old Barn", email: "a@oldbarn.example", postcode: "LS1 4AB",
      });
      await tx.insert(suppressions).values({
        nameNormalised: "the old barn", postcodeNormalised: "ls14ab",
      });

      expect(await outreachCandidates(tx, ADMIN, { segment: {}, limit: 50 })).toEqual([]);
    });
  });

  it("matches a suppression on name plus email when there is no postcode", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      await makeListing(tx, ctx, { name: "The  Old   Barn", email: "A@OldBarn.example" });
      await tx.insert(suppressions).values({
        nameNormalised: "the old barn", email: " a@oldbarn.example ",
      });

      expect(await outreachCandidates(tx, ADMIN, { segment: {}, limit: 50 })).toEqual([]);
    });
  });

  it("matches a suppression on name plus phone, however the number is punctuated", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      await makeListing(tx, ctx, {
        name: "The Old Barn", email: "a@oldbarn.example", phone: "(0113) 496-0000",
      });
      await tx.insert(suppressions).values({
        nameNormalised: "the old barn", phone: "01134960000",
      });

      expect(await outreachCandidates(tx, ADMIN, { segment: {}, limit: 50 })).toEqual([]);
    });
  });

  it("does not suppress a different business with the same name", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const other = await makeListing(tx, ctx, {
        name: "The Old Barn", email: "other@elsewhere.example", postcode: "M1 1AA",
      });
      await tx.insert(suppressions).values({
        nameNormalised: "the old barn", postcodeNormalised: "ls14ab",
      });

      const rows = await outreachCandidates(tx, ADMIN, { segment: {}, limit: 50 });
      expect(rows.map((r) => r.listingId)).toEqual([other]);
    });
  });

  it("skips a listing that has already been in a campaign", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const listingId = await makeListing(tx, ctx, { name: "Done", email: "a@done.example" });
      const [campaign] = await tx
        .insert(campaigns)
        .values({ name: "earlier" })
        .returning({ id: campaigns.id });
      await tx.insert(campaignMessages).values({
        campaignId: campaign!.id, listingId, toAddress: "a@done.example",
      });

      expect(await outreachCandidates(tx, ADMIN, { segment: {}, limit: 50 })).toEqual([]);
    });
  });

  it("filters by city slug", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const other = await makeCity(tx, "Bath", "Somerset");
      await linkCategoryToCity(tx, ctx.primaryCategoryId, other, "Category");
      const inLeeds = await makeListing(tx, ctx, { name: "Leeds One", email: "a@a.example" });
      await makeListing(tx, { ...ctx, cityId: other }, { name: "Bath One", email: "b@b.example" });

      const rows = await outreachCandidates(tx, ADMIN, { segment: { city: "leeds" }, limit: 50 });
      expect(rows.map((r) => r.listingId)).toEqual([inLeeds]);
    });
  });

  it("filters by category slug", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const otherCategory = await makeCategoryInCity(tx, ctx.verticalId, ctx.cityId, "Halls");
      const wanted = await makeListing(tx, { ...ctx, primaryCategoryId: otherCategory }, {
        name: "Hall One", email: "a@a.example",
      });
      await makeListing(tx, ctx, { name: "Other One", email: "b@b.example" });

      const rows = await outreachCandidates(tx, ADMIN, {
        segment: { category: "halls" }, limit: 50,
      });
      expect(rows.map((r) => r.listingId)).toEqual([wanted]);
    });
  });

  it("returns nothing for a city that does not exist, rather than everything", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      await makeListing(tx, ctx, { name: "One", email: "a@a.example" });
      expect(
        await outreachCandidates(tx, ADMIN, { segment: { city: "atlantis" }, limit: 50 }),
      ).toEqual([]);
    });
  });

  it("honours the limit", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      for (let i = 0; i < 5; i++) {
        await makeListing(tx, ctx, { name: `Place ${i}`, email: `p${i}@example.com` });
      }
      expect(await outreachCandidates(tx, ADMIN, { segment: {}, limit: 3 })).toHaveLength(3);
    });
  });

  it("is admin-only — this is a list of addresses", async () => {
    await withTestDb(async (tx) => {
      await makeScaffold(tx);
      await expect(
        outreachCandidates(tx, PUBLIC_VIEWER, { segment: {}, limit: 5 }),
      ).rejects.toThrow(/FORBIDDEN/);
    });
  });
});

describe("createOutreachCampaign", () => {
  it("writes the campaign, its messages and an audit row", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const listingId = await makeListing(tx, ctx, { name: "One", email: "a@a.example" });

      const campaignId = await createOutreachCampaign(tx, ADMIN, {
        name: "Leeds outreach",
        segment: { city: "leeds" },
        templateKey: "outreach-claim",
        messages: [{ listingId, toAddress: "a@a.example", magicToken: "tok-1" }],
      });

      const [campaign] = await tx.select().from(campaigns).where(eq(campaigns.id, campaignId));
      expect(campaign).toMatchObject({
        name: "Leeds outreach",
        channel: "email",
        templateKey: "outreach-claim",
        status: "draft",
        segment: { city: "leeds" },
      });
      const messages = await tx
        .select()
        .from(campaignMessages)
        .where(eq(campaignMessages.campaignId, campaignId));
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        listingId, toAddress: "a@a.example", magicToken: "tok-1", clickedAt: null, sentAt: null,
      });

      const [entry] = await tx
        .select()
        .from(auditLog)
        .where(eq(auditLog.entityId, campaignId));
      expect(entry).toMatchObject({ action: "outreach.campaign.create", entityType: "campaign" });
    });
  });

  it("is admin-only", async () => {
    await withTestDb(async (tx) => {
      await makeScaffold(tx);
      await expect(
        createOutreachCampaign(tx, PUBLIC_VIEWER, { name: "x", segment: {}, messages: [] }),
      ).rejects.toThrow(/FORBIDDEN/);
    });
  });
});

describe("recordOutreachClick", () => {
  async function seedMessage(
    tx: Parameters<Parameters<typeof withTestDb>[0]>[0],
    token: string,
  ): Promise<string> {
    const ctx = await makeScaffold(tx);
    const listingId = await makeListing(tx, ctx, { name: "One", email: "a@a.example" });
    await createOutreachCampaign(tx, ADMIN, {
      name: "c", segment: {}, messages: [{ listingId, toAddress: "a@a.example", magicToken: token }],
    });
    return listingId;
  }

  it("stamps clicked_at and hands back the listing to redirect to", async () => {
    await withTestDb(async (tx) => {
      const listingId = await seedMessage(tx, "tok-live");

      const first = await recordOutreachClick(tx, PUBLIC_VIEWER, "tok-live");

      expect(first).toEqual({ listingId });
      const [row] = await tx
        .select()
        .from(campaignMessages)
        .where(eq(campaignMessages.magicToken, "tok-live"));
      expect(row?.clickedAt).not.toBeNull();
    });
  });

  it("keeps the FIRST click's timestamp when the link is opened again", async () => {
    await withTestDb(async (tx) => {
      await seedMessage(tx, "tok-twice");
      const at = new Date("2026-09-01T09:00:00Z");
      await recordOutreachClick(tx, PUBLIC_VIEWER, "tok-twice", at);
      await recordOutreachClick(tx, PUBLIC_VIEWER, "tok-twice", new Date("2026-09-05T09:00:00Z"));

      const [row] = await tx
        .select()
        .from(campaignMessages)
        .where(eq(campaignMessages.magicToken, "tok-twice"));
      expect(row?.clickedAt?.toISOString()).toBe(at.toISOString());
    });
  });

  it("returns null for a token nobody was sent", async () => {
    await withTestDb(async (tx) => {
      await seedMessage(tx, "tok-real");
      expect(await recordOutreachClick(tx, PUBLIC_VIEWER, "tok-guessed")).toBeNull();
      expect(await recordOutreachClick(tx, PUBLIC_VIEWER, "")).toBeNull();
    });
  });

  it("refuses to resolve a token whose listing is no longer published", async () => {
    await withTestDb(async (tx) => {
      const listingId = await seedMessage(tx, "tok-removed");
      await tx.update(listings).set({ status: "removed" }).where(eq(listings.id, listingId));
      expect(await recordOutreachClick(tx, PUBLIC_VIEWER, "tok-removed")).toBeNull();
    });
  });
});
