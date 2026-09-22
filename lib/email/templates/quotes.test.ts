import { describe, it, expect } from "vitest";
import { siteConfig } from "@/config/site.config";
import { quoteAcknowledgement, quoteToRecipient, type QuoteRecipientEmailData } from "./quotes";

const base: QuoteRecipientEmailData = {
  listingName: "The Old Mill",
  leadsUrl: "https://example.co.uk/account/listings/abc/leads",
  pricingUrl: "https://example.co.uk/pricing",
  cityName: "Bath",
  categoryName: "Barn Halls",
  contactVisible: true,
  requester: { name: "Sam Requester", email: "sam@example.co.uk", phone: "01632 960000" },
  message: "Eighty people in June <script>alert(1)</script>",
};

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
