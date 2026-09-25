import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { withTestDb, type TestDb } from "@/test/db";
import { profiles, user } from "@/lib/db/schema";
import type { SendResult } from "@/lib/email/sender";
import type { Viewer } from "@/lib/db/viewer";

const sendEmail = vi.fn<(m: Record<string, unknown>) => Promise<SendResult>>();
vi.mock("@/lib/email/sender", () => ({
  sendEmail: (m: Record<string, unknown>) => sendEmail(m),
}));
vi.mock("@/lib/features/flags", async (orig) => {
  const real = await orig<typeof import("@/lib/features/flags")>();
  return { ...real, features: { ...real.features, leadMarketplace: true } };
});

const { makeScaffold } = await import("@/test/factories");
const { makeBuyer, makeLead, makeStandingOrder } = await import("@/test/leads");
const { allocateLead } = await import("@/lib/leads/allocate");
const { adminDeleteLead, buyLead, decideRefund, requestRefund } = await import("@/lib/db/queries/lead-market");
const { notifyLeadBoardDigest } = await import("@/lib/email/notify");
const { processNotifications } = await import("./notify");

const SYSTEM: Viewer = { role: "admin", userId: "00000000-0000-0000-0000-000000000000" };
const ENV = { ...process.env };
beforeEach(() => {
  sendEmail.mockReset().mockResolvedValue({ sent: true, id: "eml_1" });
  process.env.NEXT_PUBLIC_SITE_URL = "https://example.co.uk";
  process.env.EMAIL_UNSUBSCRIBE_SECRET = "unit-test-secret";
});
afterEach(() => {
  process.env = { ...ENV };
});

const to = (address: string) => sendEmail.mock.calls.map((c) => c[0]!).filter((m) => m.to === address);

async function admin(tx: TestDb): Promise<Viewer> {
  const id = `u_${randomUUID()}`;
  await tx.insert(user).values({ id, name: "Admin", email: `${id}@example.com` });
  await tx.insert(profiles).values({ userId: id, role: "admin" });
  return { role: "admin", userId: id };
}

describe("lead-market notifications", () => {
  it("won: the buyer gets the contact details and the lead's link; a lead deleted before the tick sends nothing", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const buyer = await makeBuyer(tx, ctx, 10_000);
      await makeStandingOrder(tx, buyer, { priceCents: 4000 });
      const leadId = await makeLead(tx, ctx);
      await allocateLead(tx, SYSTEM, leadId);
      await processNotifications(tx);
      const [mail] = to(buyer.email);
      expect(mail).toBeDefined();
      expect(String(mail!.text)).toContain(`lead-${leadId}@example.co.uk`);
      expect(String(mail!.text)).toMatch(/01632 97\d{4}/);
      expect(String(mail!.text)).toContain("£40");
      expect(String(mail!.text)).toContain(`https://example.co.uk/leads/${leadId}`);

      sendEmail.mockClear();
      const second = await makeLead(tx, ctx);
      await allocateLead(tx, SYSTEM, second);
      await adminDeleteLead(tx, SYSTEM, second);
      await processNotifications(tx);
      expect(to(buyer.email)).toHaveLength(0);
    });
  });

  it("top-up: the paused order's owner is told the price and balance", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const broke = await makeBuyer(tx, ctx, 1000);
      await makeStandingOrder(tx, broke, { priceCents: 3000 });
      await allocateLead(tx, SYSTEM, await makeLead(tx, ctx));
      await processNotifications(tx);
      const [mail] = to(broke.email);
      expect(String(mail!.subject)).toContain("paused");
      expect(String(mail!.text)).toContain("£30");
      expect(String(mail!.text)).toContain("£10");
      expect(String(mail!.text)).toContain("https://example.co.uk/account/credit");
    });
  });

  it("refund decided: the buyer hears the outcome", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const buyer = await makeBuyer(tx, ctx, 5000);
      const leadId = await makeLead(tx, ctx);
      await buyLead(tx, buyer.viewer, leadId, buyer.listingId);
      const req = await requestRefund(tx, buyer.viewer, { leadId, reason: "bounced", note: "" });
      await decideRefund(tx, await admin(tx), (req as { refundId: string }).refundId, { approve: true, note: "" });
      await processNotifications(tx);
      // Two emails: the board purchase's details (the buyer's record), then the decision.
      const mails = to(buyer.email);
      expect(mails).toHaveLength(2);
      expect(String(mails[0]!.text)).toContain("You bought this lead");
      expect(String(mails[0]!.text)).toContain(`lead-${leadId}@example.co.uk`);
      const mail = mails.find((m) => String(m.subject).includes("refunded"));
      expect(String(mail!.text)).toContain("The email address bounces");
    });
  });

  it("board digest: the count and a working unsubscribe link, and nothing for an account with nothing open", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const buyer = await makeBuyer(tx, ctx, 0);
      await makeStandingOrder(tx, buyer, { territories: [{ kind: "city", id: ctx.cityId }] });
      await makeLead(tx, ctx);
      const idle = await makeBuyer(tx, ctx, 0);
      await makeStandingOrder(tx, idle, { territories: [{ kind: "region", id: "nowhere-at-all" }] });
      await notifyLeadBoardDigest(tx, SYSTEM, buyer.profileId);
      await notifyLeadBoardDigest(tx, SYSTEM, idle.profileId);
      await processNotifications(tx);
      const [mail] = to(buyer.email);
      expect(String(mail!.subject)).toMatch(/^1 open lead/);
      expect(String(mail!.text)).toContain("https://example.co.uk/unsubscribe?t=");
      expect(to(idle.email)).toHaveLength(0);
    });
  });
});
