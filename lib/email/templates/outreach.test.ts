import { describe, it, expect } from "vitest";
import { siteConfig } from "@/config/site.config";
import { outreachClaimInvite, OUTREACH_UNSUBSCRIBE_NOTE } from "./outreach";

const data = {
  businessName: "The Old Mill",
  cityName: "Leeds",
  listingUrl: "https://dir.example/leeds/the-old-mill",
  magicUrl: "https://dir.example/claim/outreach/tok-1",
  couponCode: "SAVE50-7KQP4M",
  couponPercent: 50,
  removalUrl: "https://dir.example/leeds/the-old-mill#remove",
};

describe("outreachClaimInvite", () => {
  it("carries the claim link, the listing and the coupon", () => {
    const email = outreachClaimInvite(data);
    expect(email.subject).toContain("The Old Mill");
    for (const body of [email.html, email.text]) {
      expect(body).toContain(data.magicUrl);
      expect(body).toContain(data.listingUrl);
      expect(body).toContain("SAVE50-7KQP4M");
    }
  });

  it("says where the entry came from, that it is free, and how to get it removed", () => {
    // A cold message to a business that never asked to hear from us is only
    // defensible if all three are in the body.
    const { text } = outreachClaimInvite(data);
    expect(text).toMatch(/public information/i);
    expect(text).toMatch(/free/i);
    expect(text).toContain(data.removalUrl);
    expect(text).toContain(OUTREACH_UNSUBSCRIBE_NOTE);
  });

  it("takes its nouns from siteConfig, so a clone says the right word", () => {
    const { text } = outreachClaimInvite(data);
    expect(text).toContain(siteConfig.entity.plural);
    expect(text).toContain(siteConfig.name);
  });

  it("escapes a business name that contains markup", () => {
    const email = outreachClaimInvite({ ...data, businessName: '<script>alert(1)</script>' });
    expect(email.html).not.toContain("<script>");
    expect(email.html).toContain("&lt;script&gt;");
  });
});
