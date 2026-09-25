import { beforeEach, describe, expect, it } from "vitest";
import { boardDigest, leadRefundDecided, leadTopup, leadWon } from "./leads";

beforeEach(() => {
  process.env.EMAIL_UNSUBSCRIBE_SECRET = "test-secret";
});

describe("leadWon", () => {
  it("hands over the full contact details, escaped, and links the lead's page", () => {
    const m = leadWon({
      buyerName: "Pat", listingName: "Pat's Place", price: "£40", name: "Sam <b>Requester</b>", email: "sam@example.co.uk",
      phone: "01632 970001", message: "Eighty guests in June.", town: "Leeds", category: "Barn Venues",
      leadUrl: "https://example.co.uk/leads/abc",
    });
    expect(m.subject).toContain("Leeds");
    for (const s of ["sam@example.co.uk", "01632 970001", "Eighty guests in June.", "£40", "https://example.co.uk/leads/abc"]) {
      expect(m.text).toContain(s);
    }
    expect(m.html).toContain("Sam &lt;b&gt;Requester&lt;/b&gt;");
    expect(m.html).not.toContain("<b>Requester</b>");
  });

  it("says so when the requester left no phone", () => {
    const m = leadWon({
      buyerName: null, listingName: null, price: "£25", name: "Sam", email: "sam@example.co.uk", phone: null,
      message: "Hi", town: "Leeds", category: null, leadUrl: "https://example.co.uk/leads/abc",
    });
    expect(m.text).toContain("No phone");
  });
});

describe("leadTopup", () => {
  it("names the order's listing, its price and the balance, and links top-up and the orders page", () => {
    const m = leadTopup({ name: "Pat", listingName: "Pat's Place", price: "£40", balance: "£10", creditUrl: "https://x/account/credit", ordersUrl: "https://x/account/leads" });
    for (const s of ["Pat's Place", "£40", "£10", "https://x/account/credit", "https://x/account/leads"]) expect(m.text).toContain(s);
    expect(m.subject.toLowerCase()).toContain("paused");
  });
});

describe("leadRefundDecided", () => {
  it("approved: credit back; rejected: the admin's reason", () => {
    const ok = leadRefundDecided({ name: null, approved: true, blocklisted: true, price: "£25", reason: "The email address bounces", firstName: "Sam", brief: "Eighty guests", note: null, leadsUrl: "https://x/account/leads" });
    expect(ok.subject.toLowerCase()).toContain("refunded");
    expect(ok.text).toContain("£25");
    expect(ok.text).toContain("can no longer send leads");
    const typo = leadRefundDecided({ name: null, approved: true, blocklisted: false, price: "£25", reason: "The email address bounces", firstName: "Sam", brief: "Eighty guests", note: null, leadsUrl: "https://x/account/leads" });
    expect(typo.text).not.toContain("can no longer send leads");
    const no = leadRefundDecided({ name: null, approved: false, blocklisted: false, price: "£25", reason: "The email address bounces", firstName: "Sam", brief: "Eighty guests", note: "It delivered fine.", leadsUrl: "https://x/account/leads" });
    expect(no.text).toContain("It delivered fine.");
    expect(no.subject.toLowerCase()).not.toContain("refunded");
  });
});

describe("boardDigest", () => {
  it("gives the count, links the board, and carries the one-click unsubscribe", () => {
    const m = boardDigest({ name: "Pat", openCount: 3, boardUrl: "https://x/leads", ordersUrl: "https://x/account/leads", unsubscribeToken: "tok.sig" });
    expect(m.subject).toContain("3");
    expect(m.text).toContain("https://x/leads");
    expect(m.text).toContain("unsubscribe?t=tok.sig");
  });
});
