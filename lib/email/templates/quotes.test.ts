import { describe, it, expect } from "vitest";
import { siteConfig } from "@/config/site.config";
import { quoteAcknowledgement, quoteToRecipient, quoteVerifyEmail, type QuoteRecipientEmailData } from "./quotes";
import { leadSharingNotice } from "@/lib/leads/consent";

const base: QuoteRecipientEmailData = {
  listingName: "The Old Mill",
  leadsUrl: "https://example.co.uk/account/listings/abc/leads",
  pricingUrl: "https://example.co.uk/pricing",
  cityName: "Bath",
  categoryName: "Barn Halls",
  contactVisible: true,
  requester: { name: "Sam Requester", email: "sam@example.co.uk", phone: "01632 960000" },
  message: "Eighty people in June <script>alert(1)</script>",
  unsubscribeToken: "payload.signature",
};

describe("quoteToRecipient — opt-out", () => {
  it("links the unsubscribe page in both variants, and omits it only when there is no token", () => {
    for (const contactVisible of [true, false]) {
      const email = quoteToRecipient({ ...base, contactVisible });
      expect(email.text).toContain("/unsubscribe?t=payload.signature");
      expect(email.html).toContain("/unsubscribe?t=payload.signature");
    }
    expect(quoteToRecipient({ ...base, unsubscribeToken: null }).text).not.toContain("/unsubscribe");
  });
});

describe("quoteToRecipient — paid", () => {
  it("carries the job and the contact details and replies to the requester", () => {
    const email = quoteToRecipient(base);
    expect(email.replyTo).toBe("sam@example.co.uk");
    expect(email.text).toContain("Eighty people in June");
    expect(email.text).toContain("sam@example.co.uk");
    expect(email.text).toContain("01632 960000");
    expect(email.text).toContain(base.leadsUrl);
    expect(email.html).toContain("&lt;script&gt;");
    expect(email.html).not.toContain("<script>");
  });

  it("omits the phone line when none was given", () => {
    const email = quoteToRecipient({ ...base, requester: { ...base.requester, phone: null } });
    expect(email.text).not.toContain("Phone:");
  });
});

describe("quoteToRecipient — free", () => {
  it("names the town and category but neither the job nor the requester", () => {
    const email = quoteToRecipient({ ...base, contactVisible: false });
    expect(email.replyTo).toBeUndefined();
    expect(email.text).toContain("Bath");
    expect(email.text).toContain("Barn Halls");
    expect(email.text).toContain("The Old Mill");
    expect(email.text).not.toContain("Eighty people");
    expect(email.text).not.toContain("sam@example.co.uk");
    expect(email.text).not.toContain("Sam Requester");
    expect(email.text).toContain(base.pricingUrl);
    expect(email.text).toContain(base.leadsUrl);
  });

  it("says what the free tier gets, honestly", () => {
    const email = quoteToRecipient({ ...base, contactVisible: false });
    expect(email.text).toMatch(/Free listings are told a request arrived/);
    expect(email.text).toMatch(/paid plans/);
  });
});

describe("quoteAcknowledgement", () => {
  it("states the real recipient count and pluralises from siteConfig", () => {
    const one = quoteAcknowledgement({
      requesterName: "Sam", cityName: "Bath", categoryName: "Barn Halls", recipientCount: 1, message: "Hi",
    });
    expect(one.subject).toBe(`Your quote request went to 1 ${siteConfig.entity.singular}`);
    const three = quoteAcknowledgement({
      requesterName: "Sam", cityName: "Bath", categoryName: "Barn Halls", recipientCount: 3, message: "Hi",
    });
    expect(three.subject).toBe(`Your quote request went to 3 ${siteConfig.entity.plural}`);
    expect(three.text).toContain("Hello Sam");
    expect(three.text).toContain("Barn Halls in Bath to 3");
  });
});

describe("quoteAcknowledgement — the sharing line", () => {
  const data = { requesterName: "Sam", cityName: "Bath", categoryName: "Barn Halls", recipientCount: 2, message: "Hi" };

  it("keeps the original line exactly with the lead marketplace off", () => {
    for (const mail of [quoteAcknowledgement(data), quoteAcknowledgement({ ...data, leadMarketplace: false })]) {
      expect(mail.text).toContain(`${siteConfig.name} never charges you for this, and we don't sell your details.`);
      expect(mail.text).not.toContain(leadSharingNotice());
    }
  });

  it("says who may pay for it instead, from the one shared notice, with the flag on", () => {
    const mail = quoteAcknowledgement({ ...data, leadMarketplace: true });
    expect(mail.text).toContain(leadSharingNotice());
    expect(mail.text).not.toMatch(/don't sell/);
  });
});

describe("quoteVerifyEmail", () => {
  const base = {
    requesterName: "Jo", cityName: "Bath", categoryName: "Barn Halls",
    verifyUrl: "https://example.co.uk/get-quotes/verify/tok", expiresHours: 48,
  };

  it("carries the landing-page link and says nothing has been sent", () => {
    const mail = quoteVerifyEmail({ ...base, source: "quote" });
    expect(mail.text).toContain("https://example.co.uk/get-quotes/verify/tok");
    expect(mail.text).toContain("Nothing has been sent to anyone yet");
    expect(mail.text).toContain("48 hours");
  });

  it("calls an enquiry an enquiry, names the listing, and copes with no category", () => {
    const mail = quoteVerifyEmail({ ...base, categoryName: null, listingName: "Quiet Hall", source: "enquiry" });
    expect(mail.subject).toBe("Confirm your enquiry in Bath");
    expect(mail.text).toContain("your enquiry about Quiet Hall");
    expect(mail.text).not.toContain("null");
  });
});
