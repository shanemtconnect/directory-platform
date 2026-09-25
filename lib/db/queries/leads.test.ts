import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { withTestDb, type TestDb } from "@/test/db";
import { auditLog, leads, quoteRecipients, quoteRequests } from "@/lib/db/schema";
import { PUBLIC_VIEWER } from "@/lib/db/viewer";
import { makeListing, makeScaffold, type ListingCtx } from "@/test/factories";
import { resetClock, setClock } from "@/lib/clock";
import { siteConfig } from "@/config/site.config";
import {
  briefFor, createCaptureLead, createEnquiryLead, createLeadFromCaptureRequest, createLeadFromEnquiryRequest,
  createLeadFromQuote, enquiryLeadTarget,
} from "./leads";

const DAY = 86_400_000;
const NOW = new Date("2026-09-25T12:00:00Z");

afterEach(() => resetClock());

function freshPhone(): string {
  return `01632 96${String(Math.floor(Math.random() * 10_000)).padStart(4, "0")}`;
}
function freshEmail(): string {
  return `lead-${randomUUID()}@example.co.uk`;
}

/** A verified get-quotes request, as the verify route leaves it. */
async function verifiedRequest(
  tx: TestDb,
  ctx: ListingCtx,
  recipients: string[],
  patch: Partial<typeof quoteRequests.$inferInsert> = {},
): Promise<string> {
  const [row] = await tx.insert(quoteRequests).values({
    name: "Sam Requester", email: freshEmail(), phone: freshPhone(),
    message: "About eighty people in June, with parking for twenty cars.",
    cityId: ctx.cityId, categoryId: ctx.primaryCategoryId, ip: "198.51.100.4",
    consentAt: NOW, status: "verified", verifiedAt: NOW,
    ...patch,
  }).returning({ id: quoteRequests.id });
  if (recipients.length > 0) {
    await tx.insert(quoteRecipients).values(
      recipients.map((listingId) => ({ quoteRequestId: row!.id, listingId, contactMasked: true })),
    );
  }
  return row!.id;
}

describe("briefFor", () => {
  it("strips addresses, phone numbers and the surname, and keeps the job", () => {
    const brief = briefFor(
      "Hi, Sam Requester here. Eighty guests in June. Call me on 020 7946 0018 or +44 7700 900123, " +
        "email sam.requester@example.co.uk. We are at LS1 4DY.",
      { name: "Sam Requester", country: "GB" },
    );
    expect(brief).toContain("Eighty guests in June");
    expect(brief).toContain("Sam");
    expect(brief).not.toMatch(/Requester/i);
    expect(brief).not.toContain("@");
    expect(brief).not.toMatch(/\d{3}/);
    expect(brief).not.toMatch(/LS1/i);
  });

  it("strips a US ZIP and a phone with no spaces", () => {
    const brief = briefFor("Reach me at 2124567890, zip 90210, for a party of 40", { country: "US" });
    expect(brief).not.toMatch(/2124567890|90210/);
    expect(brief).toContain("party of 40");
  });

  it("never exceeds 160 characters and ends on a word", () => {
    const brief = briefFor("word ".repeat(100), { country: "GB" });
    expect(brief.length).toBeLessThanOrEqual(160);
    expect(brief.endsWith("…")).toBe(true);
    expect(brief).not.toMatch(/wor…$/);
  });

  it("leaves a short clean message alone", () => {
    expect(briefFor("  Garden wedding,\n\n about 60 guests  ", { country: "GB" })).toBe("Garden wedding, about 60 guests");
  });
});

describe("createLeadFromQuote", () => {
  it("returns null when a paid-tier local listing received the request", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const free = await makeListing(tx, ctx, { email: "free@example.com" });
      const paid = await makeListing(tx, ctx, { email: "paid@example.com", tier: "essential" });
      const id = await verifiedRequest(tx, ctx, [free, paid]);

      expect(await createLeadFromQuote(tx, PUBLIC_VIEWER, id)).toBeNull();
      expect(await tx.select().from(leads).where(eq(leads.quoteRequestId, id))).toHaveLength(0);
    });
  });

  it("creates an open lead at the floor when only free listings received it", async () => {
    await withTestDb(async (tx) => {
      setClock(NOW);
      const ctx = await makeScaffold(tx);
      const free = await makeListing(tx, ctx, { email: "free@example.com" });
      const id = await verifiedRequest(tx, ctx, [free]);

      const lead = await createLeadFromQuote(tx, PUBLIC_VIEWER, id);

      expect(lead).not.toBeNull();
      expect(lead).toMatchObject({
        source: "quote", status: "open", quoteRequestId: id, listingId: null,
        cityId: ctx.cityId, categoryId: ctx.primaryCategoryId, firstName: "Sam", name: "Sam Requester",
        priceCents: siteConfig.leads.floor * 100, soldAt: null, buyerUserId: null,
      });
      expect(lead!.phoneNormalised).toMatch(/^\+44163296\d{4}$/);
      expect(lead!.emailNormalised).toBe(lead!.email.toLowerCase());
      expect(lead!.halfPriceAt.getTime()).toBe(NOW.getTime() + siteConfig.leads.halfPriceAfterDays * DAY);
      expect(lead!.expiresAt.getTime()).toBe(NOW.getTime() + siteConfig.leads.deleteAfterDays * DAY);
      expect(lead!.brief).not.toMatch(/Requester/);

      const audit = await tx.select().from(auditLog).where(eq(auditLog.entityId, lead!.id));
      expect(audit.map((a) => a.action)).toEqual(["lead.created"]);
    });
  });

  it("creates a lead when nobody local received it at all", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const id = await verifiedRequest(tx, ctx, []);
      expect((await createLeadFromQuote(tx, PUBLIC_VIEWER, id))?.status).toBe("open");
    });
  });

  it("refuses an unverified, spam, capture or already-converted request, and a rule failure", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const pending = await verifiedRequest(tx, ctx, [], { status: "pending", verifiedAt: null });
      const spam = await verifiedRequest(tx, ctx, [], { isSpam: true });
      const capture = await verifiedRequest(tx, ctx, [], { source: "capture" });
      const noPhone = await verifiedRequest(tx, ctx, [], { phone: null });
      const once = await verifiedRequest(tx, ctx, []);

      expect(await createLeadFromQuote(tx, PUBLIC_VIEWER, pending)).toBeNull();
      expect(await createLeadFromQuote(tx, PUBLIC_VIEWER, spam)).toBeNull();
      expect(await createLeadFromQuote(tx, PUBLIC_VIEWER, capture)).toBeNull();
      expect(await createLeadFromQuote(tx, PUBLIC_VIEWER, noPhone)).toBeNull();
      expect(await createLeadFromQuote(tx, PUBLIC_VIEWER, "not-a-uuid")).toBeNull();
      expect(await createLeadFromQuote(tx, PUBLIC_VIEWER, once)).not.toBeNull();
      expect(await createLeadFromQuote(tx, PUBLIC_VIEWER, once)).toBeNull();
    });
  });
});

describe("createCaptureLead", () => {
  it("creates an open capture lead whatever the town's paid listings, and applies the rules", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      await makeListing(tx, ctx, { email: "paid@example.com", tier: "premium" });
      const email = freshEmail();
      const input = {
        cityId: ctx.cityId, categoryId: ctx.primaryCategoryId, name: "Alex Capture Person",
        email, phone: freshPhone(), message: "A small office move next month",
      };

      const lead = await createCaptureLead(tx, PUBLIC_VIEWER, input);
      expect(lead).toMatchObject({ source: "capture", status: "open", firstName: "Alex", quoteRequestId: null });

      // The same address again inside thirty days is a duplicate.
      expect(await createCaptureLead(tx, PUBLIC_VIEWER, { ...input, phone: freshPhone() })).toBeNull();
    });
  });
});

describe("createLeadFromCaptureRequest", () => {
  it("turns a verified capture request into one capture lead, and nothing else into any", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const capture = await verifiedRequest(tx, ctx, [], { source: "capture", name: "Pat Capture" });
      const pending = await verifiedRequest(tx, ctx, [], { source: "capture", status: "pending", verifiedAt: null });
      const quote = await verifiedRequest(tx, ctx, []);

      const lead = await createLeadFromCaptureRequest(tx, PUBLIC_VIEWER, capture);
      expect(lead).toMatchObject({ source: "capture", quoteRequestId: capture, firstName: "Pat", status: "open" });
      expect(await createLeadFromCaptureRequest(tx, PUBLIC_VIEWER, capture)).toBeNull();
      expect(await createLeadFromCaptureRequest(tx, PUBLIC_VIEWER, pending)).toBeNull();
      expect(await createLeadFromCaptureRequest(tx, PUBLIC_VIEWER, quote)).toBeNull();
    });
  });
});

describe("createEnquiryLead", () => {
  const enquiry = () => ({
    name: "Jo Enquirer", email: freshEmail(), phone: freshPhone(), message: "Is the hall free on 3 May?",
  });

  it("creates a lead for an unclaimed listing with no email, in its town and category", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const listing = await makeListing(tx, ctx, { email: null });

      const lead = await createEnquiryLead(tx, PUBLIC_VIEWER, listing, enquiry());

      expect(lead).toMatchObject({
        source: "enquiry", status: "open", listingId: listing, quoteRequestId: null,
        cityId: ctx.cityId, categoryId: ctx.primaryCategoryId, firstName: "Jo",
      });
    });
  });

  it("creates nothing for a listing with an email, a claimed one, or an unpublished one", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const withEmail = await makeListing(tx, ctx, { email: "hall@example.com" });
      const blankEmail = await makeListing(tx, ctx, { email: "   " });
      const claimed = await makeListing(tx, ctx, { email: null, claimStatus: "claimed" });
      const draft = await makeListing(tx, ctx, { email: null, status: "draft" });

      expect(await createEnquiryLead(tx, PUBLIC_VIEWER, withEmail, enquiry())).toBeNull();
      expect(await createEnquiryLead(tx, PUBLIC_VIEWER, claimed, enquiry())).toBeNull();
      expect(await createEnquiryLead(tx, PUBLIC_VIEWER, draft, enquiry())).toBeNull();
      expect(await createEnquiryLead(tx, PUBLIC_VIEWER, randomUUID(), enquiry())).toBeNull();
      // Whitespace is not an address.
      expect(await createEnquiryLead(tx, PUBLIC_VIEWER, blankEmail, enquiry())).not.toBeNull();
    });
  });
});

describe("createLeadFromEnquiryRequest", () => {
  it("makes the enquiry lead only once its request is verified, and only once", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const listing = await makeListing(tx, ctx, { email: null });
      expect(await enquiryLeadTarget(tx, PUBLIC_VIEWER, listing))
        .toEqual({ cityId: ctx.cityId, categoryId: ctx.primaryCategoryId });
      const pending = await verifiedRequest(tx, ctx, [], {
        source: "enquiry", listingId: listing, status: "pending", verifiedAt: null,
      });
      const verified = await verifiedRequest(tx, ctx, [], { source: "enquiry", listingId: listing, name: "Jo Enquirer" });

      expect(await createLeadFromEnquiryRequest(tx, PUBLIC_VIEWER, pending)).toBeNull();
      const lead = await createLeadFromEnquiryRequest(tx, PUBLIC_VIEWER, verified);
      expect(lead).toMatchObject({ source: "enquiry", listingId: listing, quoteRequestId: verified, firstName: "Jo" });
      expect(await createLeadFromEnquiryRequest(tx, PUBLIC_VIEWER, verified)).toBeNull();
    });
  });

  it("makes nothing if the listing was claimed between the enquiry and the click", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const listing = await makeListing(tx, ctx, { email: null });
      const verified = await verifiedRequest(tx, ctx, [], { source: "enquiry", listingId: listing });
      const { listings } = await import("@/lib/db/schema");
      await tx.update(listings).set({ claimStatus: "claimed" }).where(eq(listings.id, listing));

      expect(await enquiryLeadTarget(tx, PUBLIC_VIEWER, listing)).toBeNull();
      expect(await createLeadFromEnquiryRequest(tx, PUBLIC_VIEWER, verified)).toBeNull();
    });
  });
});
