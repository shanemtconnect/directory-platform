import { describe, expect, it } from "vitest";
import { siteConfig } from "@/config/site.config";
import { sponsorApproved, sponsorRejected, sponsorToAdmin } from "./sponsor";

const data = {
  name: "Acme <b>Ltd</b>",
  title: "Acme does the thing",
  blurb: "Properly & quickly.",
  targetUrl: "https://acme.example/l?utm_source=dir",
  advertiserEmail: "adv@example.test",
  reviewUrl: "https://example.test/admin/sponsors",
  manageUrl: "https://example.test/advertise/sponsor",
};

describe("sponsor emails", () => {
  it("the admin mail names the advertiser, links the queue, and replies to them", () => {
    const mail = sponsorToAdmin(data);
    expect(mail.subject).toContain("Acme");
    expect(mail.text).toContain("https://example.test/admin/sponsors");
    expect(mail.replyTo).toBe("adv@example.test");
    expect(mail.html).toContain("Acme &lt;b&gt;Ltd&lt;/b&gt;");
    expect(mail.html).not.toContain("<b>Ltd</b>");
  });

  it("the admin mail copes without an advertiser address", () => {
    const mail = sponsorToAdmin({ ...data, advertiserEmail: null });
    expect(mail.replyTo).toBeUndefined();
    expect(mail.text).toContain("No account email");
  });

  it("approved says it is live and where to manage it", () => {
    const mail = sponsorApproved(data);
    expect(mail.subject).toContain(siteConfig.name);
    expect(mail.text).toContain("Acme does the thing");
    expect(mail.text).toContain("https://example.test/advertise/sponsor");
  });

  it("rejected carries the reason, escaped", () => {
    const mail = sponsorRejected({ ...data, reason: "Not a real <business>." });
    expect(mail.text).toContain("Not a real <business>.");
    expect(mail.html).toContain("Not a real &lt;business&gt;.");
  });
});
