import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { withTestDb, type TestDb } from "@/test/db";
import { claims, jobQueue, profiles, user } from "@/lib/db/schema";
import { makeListing, makeScaffold } from "@/test/factories";
import type { SendResult } from "@/lib/email/sender";
import { resetClock } from "@/lib/clock";
import type { Viewer } from "@/lib/db/viewer";

const sendEmail = vi.fn<(m: Record<string, unknown>) => Promise<SendResult>>();

vi.mock("@/lib/email/sender", () => ({
  sendEmail: (m: Record<string, unknown>) => sendEmail(m),
}));

const {
  notifyClaimDecided, notifyClaimLink, notifyClaimSubmitted, NOTIFY_KINDS,
} = await import("@/lib/email/notify");
const {
  attachClaimDocument, decideClaim, startDocumentClaim, startDomainClaim, verifyClaimToken,
} = await import("@/lib/db/queries/claims");
const { processNotifications } = await import("./notify");

const ENV = { ...process.env };

beforeEach(() => {
  sendEmail.mockReset().mockResolvedValue({ sent: true, id: "eml_1" });
  process.env.ADMIN_NOTIFICATION_EMAIL = "admin@example.co.uk";
  process.env.NEXT_PUBLIC_SITE_URL = "https://example.co.uk";
});

afterEach(() => {
  process.env = { ...ENV };
  resetClock();
});

function sentTo(): string[] {
  return sendEmail.mock.calls.map((c) => String(c[0]!.to));
}

function bodies(): string {
  return sendEmail.mock.calls.map((c) => String(c[0]!.text)).join("\n");
}

async function claimant(tx: TestDb) {
  const userId = `u_${randomUUID()}`;
  await tx.insert(user).values({
    id: userId, name: "Jo", email: `${userId}@account.test`, emailVerified: true,
  });
  const [profile] = await tx.insert(profiles).values({ userId }).returning({ id: profiles.id });
  return { userId, profileId: profile!.id, viewer: { role: "user", userId } as Viewer, accountEmail: `${userId}@account.test` };
}

async function listing(tx: TestDb) {
  const ctx = await makeScaffold(tx);
  return makeListing(tx, ctx, { name: "The Old Mill", website: "https://oldmill.example" });
}

describe("claim notification kinds", () => {
  it("are all claimed by the notification worker", () => {
    expect(NOTIFY_KINDS).toEqual(
      expect.arrayContaining(["notify.claimLink", "notify.claimSubmitted", "notify.claimDecided"]),
    );
  });
});

describe("notify.claimLink", () => {
  it("emails the magic link to the business address and nowhere else", async () => {
    await withTestDb(async (tx) => {
      const listingId = await listing(tx);
      const jo = await claimant(tx);
      const started = await startDomainClaim(tx, jo.viewer, {
        listingId, profileId: jo.profileId, businessEmail: "jo@oldmill.example",
        claimantName: "Jo", roleAtBusiness: null, ip: null, userAgent: null,
      });
      if (started.outcome !== "sent") throw new Error("setup failed");
      await notifyClaimLink(tx, jo.viewer, started.claimId);

      expect(await processNotifications(tx)).toBe(1);
      // Never the admin: the link IS the credential.
      expect(sentTo()).toEqual(["jo@oldmill.example"]);
      expect(bodies()).toContain(`https://example.co.uk/claim/verify/${started.token}`);
    });
  });

  it("completes without sending when the claim has already been decided", async () => {
    await withTestDb(async (tx) => {
      const listingId = await listing(tx);
      const jo = await claimant(tx);
      const started = await startDomainClaim(tx, jo.viewer, {
        listingId, profileId: jo.profileId, businessEmail: "jo@oldmill.example",
        claimantName: "Jo", roleAtBusiness: null, ip: null, userAgent: null,
      });
      if (started.outcome !== "sent") throw new Error("setup failed");
      await notifyClaimLink(tx, jo.viewer, started.claimId);
      // A resend, or a worker that was behind: by the time the job runs the
      // claim is settled. Mailing a live-looking link at that point is at best
      // confusing and at worst a credential nobody needs any more.
      await verifyClaimToken(tx, { role: "public" }, started.token);

      expect(await processNotifications(tx)).toBe(1);
      expect(sendEmail).not.toHaveBeenCalled();
      const [job] = await tx.select().from(jobQueue);
      expect(job?.status, "and the job is finished, not retried for ever").toBe("done");
    });
  });

  it("completes without sending when the token has expired", async () => {
    await withTestDb(async (tx) => {
      const listingId = await listing(tx);
      const jo = await claimant(tx);
      const started = await startDomainClaim(tx, jo.viewer, {
        listingId, profileId: jo.profileId, businessEmail: "jo@oldmill.example",
        claimantName: "Jo", roleAtBusiness: null, ip: null, userAgent: null,
      });
      if (started.outcome !== "sent") throw new Error("setup failed");
      await notifyClaimLink(tx, jo.viewer, started.claimId);
      // Aged in the row rather than on the clock: `job_queue.run_after` is a
      // database default, so winding the application clock back past it would
      // make the job not due yet and nothing would run at all.
      await tx
        .update(claims)
        .set({ magicTokenExpiresAt: new Date("2020-01-01T00:00:00Z") })
        .where(eq(claims.id, started.claimId));

      expect(await processNotifications(tx)).toBe(1);
      expect(sendEmail).not.toHaveBeenCalled();
      const [job] = await tx.select().from(jobQueue);
      expect(job?.status).toBe("done");
    });
  });

  it("retries rather than losing the job when the claim is not there", async () => {
    await withTestDb(async (tx) => {
      const { enqueueJob } = await import("@/lib/db/queries/jobs");
      await enqueueJob(tx, { role: "admin", userId: "x" }, {
        kind: "notify.claimLink", payload: { claimId: randomUUID() },
      });
      expect(await processNotifications(tx)).toBe(0);
      const [job] = await tx.select().from(jobQueue);
      expect(job?.status).toBe("pending");
      expect(job?.attempts).toBe(1);
      expect(sendEmail).not.toHaveBeenCalled();
    });
  });
});

describe("notify.claimSubmitted", () => {
  it("tells the admin a document claim is waiting, with a link to review it", async () => {
    await withTestDb(async (tx) => {
      const listingId = await listing(tx);
      const jo = await claimant(tx);
      const started = await startDocumentClaim(tx, jo.viewer, {
        listingId, profileId: jo.profileId, claimantName: "Jo Bloggs",
        roleAtBusiness: "Owner", evidenceNotes: null, ip: null, userAgent: null,
      });
      if (started.outcome !== "open") throw new Error("setup failed");
      await attachClaimDocument(tx, jo.viewer, {
        claimId: started.claimId, profileId: jo.profileId, path: "claims/p/proof.pdf", ip: null,
      });
      await notifyClaimSubmitted(tx, jo.viewer, started.claimId);

      expect(await processNotifications(tx)).toBe(1);
      expect(sentTo()).toEqual(["admin@example.co.uk"]);
      expect(bodies()).toContain(`https://example.co.uk/admin/claims/${started.claimId}`);
    });
  });
});

describe("notify.claimDecided", () => {
  async function decided(tx: TestDb, decision: "approved" | "rejected") {
    const listingId = await listing(tx);
    const jo = await claimant(tx);
    const started = await startDocumentClaim(tx, jo.viewer, {
      listingId, profileId: jo.profileId, claimantName: "Jo Bloggs",
      roleAtBusiness: null, evidenceNotes: null, ip: null, userAgent: null,
    });
    if (started.outcome !== "open") throw new Error("setup failed");

    const adminUserId = `u_${randomUUID()}`;
    await tx.insert(user).values({
      id: adminUserId, name: "A", email: `${adminUserId}@account.test`, emailVerified: true,
    });
    const [adminProfile] = await tx
      .insert(profiles).values({ userId: adminUserId, role: "admin" })
      .returning({ id: profiles.id });
    await decideClaim(tx, { role: "admin", userId: adminUserId }, {
      claimId: started.claimId, decision,
      reason: decision === "rejected" ? "The document did not name the business." : null,
      actorProfileId: adminProfile!.id, ip: null,
    });
    await notifyClaimDecided(tx, { role: "admin", userId: adminUserId }, started.claimId);
    return { ...jo, claimId: started.claimId };
  }

  it("sends the approval to the account that claimed it, pointing at the dashboard", async () => {
    await withTestDb(async (tx) => {
      const jo = await decided(tx, "approved");
      expect(await processNotifications(tx)).toBe(1);
      expect(sentTo()).toEqual([jo.accountEmail]);
      expect(bodies()).toContain("https://example.co.uk/account");
    });
  });

  it("sends the rejection with the reason the admin gave", async () => {
    await withTestDb(async (tx) => {
      const jo = await decided(tx, "rejected");
      expect(await processNotifications(tx)).toBe(1);
      expect(sentTo()).toEqual([jo.accountEmail]);
      expect(bodies()).toContain("The document did not name the business.");
    });
  });

  it("does not send anything for a claim that is still pending", async () => {
    await withTestDb(async (tx) => {
      const listingId = await listing(tx);
      const jo = await claimant(tx);
      const started = await startDocumentClaim(tx, jo.viewer, {
        listingId, profileId: jo.profileId, claimantName: null,
        roleAtBusiness: null, evidenceNotes: null, ip: null, userAgent: null,
      });
      if (started.outcome !== "open") throw new Error("setup failed");
      await notifyClaimDecided(tx, jo.viewer, started.claimId);

      expect(await processNotifications(tx)).toBe(0);
      expect(sendEmail).not.toHaveBeenCalled();
      const [job] = await tx.select().from(jobQueue).where(eq(jobQueue.kind, "notify.claimDecided"));
      expect(job?.attempts).toBe(1);
    });
  });
});
