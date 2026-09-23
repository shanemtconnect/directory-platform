import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTestDb, type TestDb } from "@/test/db";
import { jobQueue, profiles, user } from "@/lib/db/schema";
import type { Viewer } from "@/lib/db/viewer";
import { ADMIN_VIEWER } from "@/worker/viewer";
import type { SendResult } from "@/lib/email/sender";
import { createSponsorCampaign, decideSponsorCampaign } from "@/lib/db/queries/ads";

const sendEmail = vi.fn<(m: Record<string, unknown>) => Promise<SendResult>>();
vi.mock("@/lib/email/sender", () => ({ sendEmail: (m: Record<string, unknown>) => sendEmail(m) }));

const { notifySponsorDecided, notifySponsorSubmitted } = await import("@/lib/email/notify");
const { processSponsorNotifications } = await import("./notify-sponsors");
const { processNotifications } = await import("./notify");

const ENV = { ...process.env };
beforeEach(() => {
  sendEmail.mockReset().mockResolvedValue({ sent: true, id: "eml_1" });
  process.env.ADMIN_NOTIFICATION_EMAIL = "admin@example.co.uk";
  process.env.NEXT_PUBLIC_SITE_URL = "https://example.co.uk";
});
afterEach(() => {
  process.env = { ...ENV };
});

async function advertiser(tx: TestDb): Promise<{ viewer: Viewer; profileId: string; email: string }> {
  const userId = `u_${randomUUID()}`;
  const email = `${userId}@example.test`;
  await tx.insert(user).values({ id: userId, name: "Adv", email });
  const [p] = await tx.insert(profiles).values({ userId }).returning({ id: profiles.id });
  return { viewer: { role: "user", userId }, profileId: p!.id, email };
}

async function campaign(tx: TestDb, a: { viewer: Viewer; profileId: string }): Promise<string> {
  const r = await createSponsorCampaign(tx, a.viewer, {
    profileId: a.profileId, name: "Acme", title: "Acme does it", blurb: "b",
    targetUrl: "https://acme.example/", placements: ["search"], logoPath: null, ip: null,
  });
  if (r.outcome !== "created") throw new Error(r.outcome);
  return r.campaignId;
}

const recipients = () => sendEmail.mock.calls.map((c) => String(c[0]!.to));

describe("processSponsorNotifications", () => {
  it("submitted → the admin, with a link to the queue; the main drain leaves it alone", async () => {
    await withTestDb(async (tx) => {
      const a = await advertiser(tx);
      const id = await campaign(tx, a);
      await notifySponsorSubmitted(tx, a.viewer, id);
      expect(await processNotifications(tx)).toBe(0);
      expect(await processSponsorNotifications(tx)).toBe(1);
      expect(recipients()).toEqual(["admin@example.co.uk"]);
      expect(String(sendEmail.mock.calls[0]![0]!.text)).toContain("https://example.co.uk/admin/sponsors");
      const [job] = await tx.select().from(jobQueue).where(eq(jobQueue.kind, "notify.sponsor.submitted"));
      expect(job!.status).toBe("done");
    });
  });

  it("decided → approved mail to the advertiser; rejected mail carries the reason", async () => {
    await withTestDb(async (tx) => {
      const a = await advertiser(tx);
      const id = await campaign(tx, a);
      await decideSponsorCampaign(tx, ADMIN_VIEWER, id, { decision: "approve", ip: null });
      await notifySponsorDecided(tx, ADMIN_VIEWER, id);
      await processSponsorNotifications(tx);
      expect(recipients()).toEqual([a.email]);
      expect(String(sendEmail.mock.calls[0]![0]!.subject)).toContain("live");

      const other = await campaign(tx, a);
      await decideSponsorCampaign(tx, ADMIN_VIEWER, other, { decision: "reject", reason: "Not for this site.", ip: null });
      await notifySponsorDecided(tx, ADMIN_VIEWER, other);
      await processSponsorNotifications(tx);
      expect(String(sendEmail.mock.calls[1]![0]!.text)).toContain("Not for this site.");
    });
  });

  it("a paused campaign announces nothing, and a job for a missing campaign is retried not parked", async () => {
    await withTestDb(async (tx) => {
      const a = await advertiser(tx);
      const id = await campaign(tx, a);
      await decideSponsorCampaign(tx, ADMIN_VIEWER, id, { decision: "approve", ip: null });
      await decideSponsorCampaign(tx, ADMIN_VIEWER, id, { decision: "pause", ip: null });
      await notifySponsorDecided(tx, ADMIN_VIEWER, id);
      expect(await processSponsorNotifications(tx)).toBe(1);
      expect(sendEmail).not.toHaveBeenCalled();

      await notifySponsorDecided(tx, ADMIN_VIEWER, randomUUID());
      expect(await processSponsorNotifications(tx)).toBe(0);
      const [job] = await tx.select().from(jobQueue).where(eq(jobQueue.status, "pending"));
      expect(job?.attempts).toBe(1);
    });
  });
});
