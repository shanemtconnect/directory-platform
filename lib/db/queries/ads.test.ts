import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { auditLog, profiles, sponsorCampaigns, sponsorStatsDaily, user } from "@/lib/db/schema";
import { PUBLIC_VIEWER, type Viewer } from "@/lib/db/viewer";
import { ADMIN_VIEWER } from "@/worker/viewer";
import { resetClock, setClock } from "@/lib/clock";
import { withTestDb, type TestDb } from "@/test/db";
import {
  activeSponsorCampaigns,
  advertiserCampaigns,
  applySponsorBillingEffect,
  applySponsorStatDeltas,
  attachSponsorSubscription,
  createSponsorCampaign,
  decideSponsorCampaign,
  listSponsorQueue,
  pendingSponsorCount,
  sponsorCampaignForBilling,
  sponsorCampaignForClick,
  sponsorNotification,
  updateSponsorCampaign,
} from "./ads";

const NOW = new Date("2026-09-22T10:00:00Z");
const IP = "203.0.113.9";

afterEach(resetClock);

async function makePerson(
  tx: TestDb,
  role: "user" | "admin" = "user",
): Promise<{ viewer: Viewer; profileId: string; email: string }> {
  const userId = `u_${randomUUID()}`;
  const email = `${userId}@example.com`;
  await tx.insert(user).values({ id: userId, name: "Someone", email });
  const [row] = await tx.insert(profiles).values({ userId, role }).returning({ id: profiles.id });
  return { viewer: { role, userId }, profileId: row!.id, email };
}

const CAMPAIGN = {
  name: "Acme Ltd",
  title: "Acme does the thing",
  blurb: "The thing, done properly, since 1990.",
  targetUrl: "https://acme.example/landing?utm_source=x",
  placements: ["cityPillar", "search"],
  logoPath: null,
  ip: IP,
};

async function created(tx: TestDb, viewer: Viewer, profileId: string): Promise<string> {
  const result = await createSponsorCampaign(tx, viewer, { ...CAMPAIGN, profileId });
  if (result.outcome !== "created") throw new Error(result.outcome);
  return result.campaignId;
}

async function approved(tx: TestDb, viewer: Viewer, profileId: string): Promise<string> {
  const id = await created(tx, viewer, profileId);
  const decided = await decideSponsorCampaign(tx, ADMIN_VIEWER, id, { decision: "approve", ip: IP });
  expect(decided.outcome).toBe("decided");
  return id;
}

describe("createSponsorCampaign", () => {
  it("refuses the public viewer", async () => {
    await withTestDb(async (tx) => {
      const { profileId } = await makePerson(tx);
      await expect(
        createSponsorCampaign(tx, PUBLIC_VIEWER, { ...CAMPAIGN, profileId }),
      ).rejects.toThrow("FORBIDDEN");
    });
  });

  it("stores a pending campaign owned by the profile and audits it with the ip", async () => {
    await withTestDb(async (tx) => {
      setClock(NOW);
      const { viewer, profileId } = await makePerson(tx);
      const id = await created(tx, viewer, profileId);
      const [row] = await tx.select().from(sponsorCampaigns).where(eq(sponsorCampaigns.id, id));
      expect(row).toMatchObject({
        advertiserId: profileId,
        status: "pending",
        billingStatus: "none",
        placements: ["cityPillar", "search"],
        weight: 1,
      });
      const [audit] = await tx
        .select()
        .from(auditLog)
        .where(eq(auditLog.entityId, id));
      expect(audit).toMatchObject({ action: "sponsor.create", entityType: "sponsor_campaign", ip: IP });
      expect(audit!.actorId).toBe(profileId);
    });
  });

  it("rejects a title or blurb over the cap, an unsafe url and an unknown placement", async () => {
    await withTestDb(async (tx) => {
      const { viewer, profileId } = await makePerson(tx);
      const base = { ...CAMPAIGN, profileId };
      expect(await createSponsorCampaign(tx, viewer, { ...base, title: "x".repeat(61) })).toEqual({
        outcome: "invalid", field: "title",
      });
      expect(await createSponsorCampaign(tx, viewer, { ...base, blurb: "x".repeat(121) })).toEqual({
        outcome: "invalid", field: "blurb",
      });
      expect(await createSponsorCampaign(tx, viewer, { ...base, targetUrl: "javascript:alert(1)" })).toEqual({
        outcome: "invalid", field: "targetUrl",
      });
      expect(await createSponsorCampaign(tx, viewer, { ...base, placements: ["home"] })).toEqual({
        outcome: "invalid", field: "placements",
      });
      expect(await createSponsorCampaign(tx, viewer, { ...base, placements: [] })).toEqual({
        outcome: "invalid", field: "placements",
      });
      expect(await createSponsorCampaign(tx, viewer, { ...base, name: "  " })).toEqual({
        outcome: "invalid", field: "name",
      });
    });
  });
});

describe("advertiserCampaigns / updateSponsorCampaign — owner scoped", () => {
  it("lists only the caller's own campaigns", async () => {
    await withTestDb(async (tx) => {
      const a = await makePerson(tx);
      const b = await makePerson(tx);
      const mine = await created(tx, a.viewer, a.profileId);
      await created(tx, b.viewer, b.profileId);
      const rows = await advertiserCampaigns(tx, a.viewer, a.profileId);
      expect(rows.map((r) => r.id)).toEqual([mine]);
      await expect(advertiserCampaigns(tx, PUBLIC_VIEWER, a.profileId)).rejects.toThrow("FORBIDDEN");
    });
  });

  it("a stranger cannot edit it; the owner can, and a live campaign goes back to pending", async () => {
    await withTestDb(async (tx) => {
      const a = await makePerson(tx);
      const b = await makePerson(tx);
      const id = await approved(tx, a.viewer, a.profileId);
      const patch = { campaignId: id, title: "New title", blurb: "New blurb", targetUrl: "https://acme.example/", ip: IP };
      expect(await updateSponsorCampaign(tx, b.viewer, { ...patch, profileId: b.profileId })).toBe("unknown");
      expect(await updateSponsorCampaign(tx, a.viewer, { ...patch, profileId: a.profileId })).toBe("updated");
      const [row] = await tx.select().from(sponsorCampaigns).where(eq(sponsorCampaigns.id, id));
      expect(row).toMatchObject({ title: "New title", status: "pending" });
      const audits = await tx.select().from(auditLog).where(eq(auditLog.entityId, id));
      expect(audits.map((x) => x.action).sort()).toEqual(["sponsor.approve", "sponsor.create", "sponsor.edit"]);
      expect(audits.every((x) => x.ip === IP)).toBe(true);
    });
  });

  it("an edit to a paused campaign keeps the admin's pause (I6)", async () => {
    await withTestDb(async (tx) => {
      const a = await makePerson(tx);
      const id = await approved(tx, a.viewer, a.profileId);
      await decideSponsorCampaign(tx, ADMIN_VIEWER, id, { decision: "pause", ip: IP });
      const patch = { campaignId: id, profileId: a.profileId, title: "t2", blurb: "b2", targetUrl: "https://acme.example/", ip: IP };
      expect(await updateSponsorCampaign(tx, a.viewer, patch)).toBe("updated");
      const [row] = await tx.select().from(sponsorCampaigns).where(eq(sponsorCampaigns.id, id));
      expect(row).toMatchObject({ title: "t2", status: "paused" });
      const pendingOne = await created(tx, a.viewer, a.profileId);
      expect(await updateSponsorCampaign(tx, a.viewer, { ...patch, campaignId: pendingOne })).toBe("updated");
      const [p] = await tx.select().from(sponsorCampaigns).where(eq(sponsorCampaigns.id, pendingOne));
      expect(p!.status).toBe("pending");
    });
  });

  it("refuses an invalid edit and an edit to an ended campaign", async () => {
    await withTestDb(async (tx) => {
      const a = await makePerson(tx);
      const id = await created(tx, a.viewer, a.profileId);
      const patch = { campaignId: id, profileId: a.profileId, title: "t", blurb: "b", ip: IP };
      expect(await updateSponsorCampaign(tx, a.viewer, { ...patch, targetUrl: "ftp://x" })).toBe("invalid");
      await decideSponsorCampaign(tx, ADMIN_VIEWER, id, { decision: "end", ip: IP });
      expect(await updateSponsorCampaign(tx, a.viewer, { ...patch, targetUrl: "https://x.example/" })).toBe("unknown");
    });
  });
});

describe("decideSponsorCampaign — admin only, audited with ip", () => {
  it("refuses anyone but an admin", async () => {
    await withTestDb(async (tx) => {
      const a = await makePerson(tx);
      const id = await created(tx, a.viewer, a.profileId);
      await expect(
        decideSponsorCampaign(tx, a.viewer, id, { decision: "approve", ip: IP }),
      ).rejects.toThrow("FORBIDDEN");
      await expect(listSponsorQueue(tx, a.viewer)).rejects.toThrow("FORBIDDEN");
    });
  });

  it("approve → active with a start date; pause; resume; end — each audited", async () => {
    await withTestDb(async (tx) => {
      setClock(NOW);
      const a = await makePerson(tx);
      const admin = await makePerson(tx, "admin");
      const id = await created(tx, a.viewer, a.profileId);
      const decide = (decision: "approve" | "pause" | "resume" | "end") =>
        decideSponsorCampaign(tx, admin.viewer, id, { decision, ip: IP });
      const status = async () =>
        (await tx.select({ s: sponsorCampaigns.status, starts: sponsorCampaigns.startsAt, ends: sponsorCampaigns.endsAt })
          .from(sponsorCampaigns).where(eq(sponsorCampaigns.id, id)))[0]!;

      expect((await decide("approve")).outcome).toBe("decided");
      expect(await status()).toMatchObject({ s: "active", starts: NOW });
      expect((await decide("pause")).outcome).toBe("decided");
      expect((await status()).s).toBe("paused");
      expect((await decide("resume")).outcome).toBe("decided");
      expect((await status()).s).toBe("active");
      expect((await decide("end")).outcome).toBe("decided");
      expect(await status()).toMatchObject({ s: "ended", ends: NOW });
      // nothing further
      expect((await decide("approve")).outcome).toBe("not-allowed");

      const audits = await tx.select().from(auditLog).where(eq(auditLog.entityId, id));
      const actions = audits.map((x) => x.action).sort();
      expect(actions).toEqual(["sponsor.approve", "sponsor.create", "sponsor.end", "sponsor.pause", "sponsor.resume"]);
      expect(audits.filter((x) => x.action !== "sponsor.create").every((x) => x.actorId === admin.profileId && x.ip === IP)).toBe(true);
    });
  });

  it("reject needs a reason and stores it", async () => {
    await withTestDb(async (tx) => {
      const a = await makePerson(tx);
      const id = await created(tx, a.viewer, a.profileId);
      expect(await decideSponsorCampaign(tx, ADMIN_VIEWER, id, { decision: "reject", reason: "   ", ip: IP }))
        .toEqual({ outcome: "reason-required" });
      expect(await decideSponsorCampaign(tx, ADMIN_VIEWER, id, { decision: "reject", reason: "Not a real business.", ip: IP }))
        .toEqual({ outcome: "decided" });
      const [row] = await tx.select().from(sponsorCampaigns).where(eq(sponsorCampaigns.id, id));
      expect(row).toMatchObject({ status: "rejected", rejectionReason: "Not a real business." });
      expect(await decideSponsorCampaign(tx, ADMIN_VIEWER, randomUUID(), { decision: "approve", ip: IP }))
        .toEqual({ outcome: "unknown" });
    });
  });

  it("the queue lists pending first and never ended or rejected ones; the count is pending only", async () => {
    await withTestDb(async (tx) => {
      const a = await makePerson(tx);
      const live = await approved(tx, a.viewer, a.profileId);
      const waiting = await created(tx, a.viewer, a.profileId);
      const gone = await created(tx, a.viewer, a.profileId);
      await decideSponsorCampaign(tx, ADMIN_VIEWER, gone, { decision: "end", ip: IP });
      const queue = await listSponsorQueue(tx, ADMIN_VIEWER);
      expect(queue.map((c) => c.id)).toEqual([waiting, live]);
      expect(queue[0]).toMatchObject({ advertiserEmail: a.email, status: "pending" });
      expect(await pendingSponsorCount(tx, ADMIN_VIEWER)).toBe(1);
    });
  });
});

describe("activeSponsorCampaigns — what the rails may show", () => {
  it("returns only active campaigns inside their window, for the placement asked", async () => {
    await withTestDb(async (tx) => {
      setClock(NOW);
      const a = await makePerson(tx);
      const live = await approved(tx, a.viewer, a.profileId);
      await created(tx, a.viewer, a.profileId); // pending
      const paused = await approved(tx, a.viewer, a.profileId);
      await decideSponsorCampaign(tx, ADMIN_VIEWER, paused, { decision: "pause", ip: IP });
      const ended = await approved(tx, a.viewer, a.profileId);
      await decideSponsorCampaign(tx, ADMIN_VIEWER, ended, { decision: "end", ip: IP });

      const rows = await activeSponsorCampaigns(tx, PUBLIC_VIEWER, { placement: "cityPillar", at: NOW });
      expect(rows.map((r) => r.id)).toEqual([live]);
      expect(rows[0]).toMatchObject({ name: "Acme Ltd", title: CAMPAIGN.title, blurb: CAMPAIGN.blurb, weight: 1 });
      expect(await activeSponsorCampaigns(tx, PUBLIC_VIEWER, { placement: "blog", at: NOW })).toEqual([]);
    });
  });

  it("respects starts_at / ends_at and a lapsed subscription", async () => {
    await withTestDb(async (tx) => {
      setClock(NOW);
      const a = await makePerson(tx);
      const id = await approved(tx, a.viewer, a.profileId);
      const later = new Date(NOW.getTime() + 86_400_000);
      await tx.update(sponsorCampaigns).set({ endsAt: later }).where(eq(sponsorCampaigns.id, id));
      expect((await activeSponsorCampaigns(tx, PUBLIC_VIEWER, { placement: "search", at: NOW })).length).toBe(1);
      expect((await activeSponsorCampaigns(tx, PUBLIC_VIEWER, { placement: "search", at: later })).length).toBe(0);
      await tx.update(sponsorCampaigns).set({ endsAt: null, billingStatus: "suspended" }).where(eq(sponsorCampaigns.id, id));
      expect((await activeSponsorCampaigns(tx, PUBLIC_VIEWER, { placement: "search", at: NOW })).length).toBe(0);
      await tx.update(sponsorCampaigns).set({ billingStatus: "cancelled" }).where(eq(sponsorCampaigns.id, id));
      // cancelled keeps running until ends_at, which the billing effect sets
      expect((await activeSponsorCampaigns(tx, PUBLIC_VIEWER, { placement: "search", at: NOW })).length).toBe(1);
    });
  });

  it("sponsorCampaignForClick answers the same question for one id", async () => {
    await withTestDb(async (tx) => {
      setClock(NOW);
      const a = await makePerson(tx);
      const live = await approved(tx, a.viewer, a.profileId);
      const pending = await created(tx, a.viewer, a.profileId);
      expect(await sponsorCampaignForClick(tx, PUBLIC_VIEWER, live, NOW)).toEqual({ id: live, targetUrl: CAMPAIGN.targetUrl });
      expect(await sponsorCampaignForClick(tx, PUBLIC_VIEWER, pending, NOW)).toBeNull();
      expect(await sponsorCampaignForClick(tx, PUBLIC_VIEWER, "not-a-uuid", NOW)).toBeNull();
    });
  });
});

describe("applySponsorStatDeltas", () => {
  it("adds on conflict, drops unknown campaigns, and is worker only", async () => {
    await withTestDb(async (tx) => {
      const a = await makePerson(tx);
      const id = await created(tx, a.viewer, a.profileId);
      const delta = { campaignId: id, day: "2026-09-22", impressions: 3, clicks: 1 };
      await expect(applySponsorStatDeltas(tx, a.viewer, [delta])).rejects.toThrow("FORBIDDEN");
      expect(await applySponsorStatDeltas(tx, ADMIN_VIEWER, [delta])).toBe(1);
      expect(await applySponsorStatDeltas(tx, ADMIN_VIEWER, [delta, { ...delta, campaignId: randomUUID() }])).toBe(1);
      const [row] = await tx.select().from(sponsorStatsDaily).where(eq(sponsorStatsDaily.campaignId, id));
      expect(row).toMatchObject({ impressions: 6, clicks: 2 });
      expect(await applySponsorStatDeltas(tx, ADMIN_VIEWER, [{ ...delta, impressions: 0, clicks: 0 }])).toBe(0);
    });
  });
});

describe("billing hooks", () => {
  it("attaches a provider subscription for the owner only and finds it again by either id", async () => {
    await withTestDb(async (tx) => {
      const a = await makePerson(tx);
      const b = await makePerson(tx);
      const id = await created(tx, a.viewer, a.profileId);
      expect(await attachSponsorSubscription(tx, b.viewer, { campaignId: id, profileId: b.profileId, providerSubscriptionId: "I-XYZ" })).toBe(false);
      expect(await attachSponsorSubscription(tx, a.viewer, { campaignId: id, profileId: a.profileId, providerSubscriptionId: "I-XYZ" })).toBe(true);
      const byProvider = await sponsorCampaignForBilling(tx, ADMIN_VIEWER, { providerSubscriptionId: "I-XYZ", customId: null });
      expect(byProvider).toMatchObject({ id, billingStatus: "approval_pending" });
      const byCustom = await sponsorCampaignForBilling(tx, ADMIN_VIEWER, { providerSubscriptionId: null, customId: id });
      expect(byCustom?.id).toBe(id);
      expect(await sponsorCampaignForBilling(tx, ADMIN_VIEWER, { providerSubscriptionId: "I-NOPE", customId: null })).toBeNull();
      await expect(sponsorCampaignForBilling(tx, a.viewer, { providerSubscriptionId: "I-XYZ", customId: null })).rejects.toThrow("FORBIDDEN");
    });
  });

  it("applySponsorBillingEffect writes the billing columns and an audit row keyed on the event", async () => {
    await withTestDb(async (tx) => {
      const a = await makePerson(tx);
      const id = await created(tx, a.viewer, a.profileId);
      const end = new Date("2026-10-22T10:00:00Z");
      await applySponsorBillingEffect(tx, ADMIN_VIEWER, id, {
        billingStatus: "active", currentPeriodEnd: end, endsAt: undefined, eventId: "WH-1", action: "activate",
      });
      let [row] = await tx.select().from(sponsorCampaigns).where(eq(sponsorCampaigns.id, id));
      expect(row).toMatchObject({ billingStatus: "active", currentPeriodEnd: end, endsAt: null });
      await applySponsorBillingEffect(tx, ADMIN_VIEWER, id, {
        billingStatus: "cancelled", currentPeriodEnd: end, endsAt: end, eventId: "WH-2", action: "cancel",
      });
      [row] = await tx.select().from(sponsorCampaigns).where(eq(sponsorCampaigns.id, id));
      expect(row).toMatchObject({ billingStatus: "cancelled", endsAt: end });
      const audits = await tx.select().from(auditLog).where(eq(auditLog.entityId, id));
      expect(audits.filter((x) => x.action === "sponsor.billing").map((x) => (x.meta as { eventId: string }).eventId)).toEqual(["WH-1", "WH-2"]);
    });
  });
});

describe("sponsorNotification", () => {
  it("names the advertiser's account email and the decision", async () => {
    await withTestDb(async (tx) => {
      const a = await makePerson(tx);
      const id = await created(tx, a.viewer, a.profileId);
      await decideSponsorCampaign(tx, ADMIN_VIEWER, id, { decision: "reject", reason: "Nope, not this.", ip: IP });
      const data = await sponsorNotification(tx, ADMIN_VIEWER, id);
      expect(data).toMatchObject({
        campaignId: id, advertiserEmail: a.email, name: "Acme Ltd", title: CAMPAIGN.title,
        status: "rejected", rejectionReason: "Nope, not this.",
      });
      expect(await sponsorNotification(tx, ADMIN_VIEWER, randomUUID())).toBeNull();
      await expect(sponsorNotification(tx, a.viewer, id)).rejects.toThrow("FORBIDDEN");
    });
  });
});

describe("self-serve helpers", () => {
  it("setSponsorLogo and advertiserCampaignBySubscription are owner scoped", async () => {
    await withTestDb(async (tx) => {
      const a = await makePerson(tx);
      const b = await makePerson(tx);
      const id = await created(tx, a.viewer, a.profileId);
      const { setSponsorLogo, advertiserCampaignBySubscription } = await import("./ads");
      expect(await setSponsorLogo(tx, b.viewer, { campaignId: id, profileId: b.profileId, logoPath: "x" })).toBe(false);
      expect(await setSponsorLogo(tx, a.viewer, { campaignId: id, profileId: a.profileId, logoPath: "sponsors/x/logo.webp" })).toBe(true);
      await attachSponsorSubscription(tx, a.viewer, { campaignId: id, profileId: a.profileId, providerSubscriptionId: "I-OWN" });
      expect(await advertiserCampaignBySubscription(tx, a.viewer, { profileId: a.profileId, providerSubscriptionId: "I-OWN" }))
        .toEqual({ id, billingStatus: "approval_pending" });
      expect(await advertiserCampaignBySubscription(tx, b.viewer, { profileId: b.profileId, providerSubscriptionId: "I-OWN" })).toBeNull();
      await expect(advertiserCampaignBySubscription(tx, PUBLIC_VIEWER, { profileId: a.profileId, providerSubscriptionId: "I-OWN" })).rejects.toThrow("FORBIDDEN");
    });
  });
});
