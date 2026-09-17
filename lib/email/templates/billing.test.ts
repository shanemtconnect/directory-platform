import { describe, expect, it } from "vitest";
import { siteConfig } from "@/config/site.config";
import { renewalReminder, REMINDER_OFFSETS } from "./billing";

const data = {
  listingName: "The Old Mill",
  listingUrl: "https://example.test/leeds/the-old-mill",
  billingUrl: "https://example.test/account/billing",
  tierLabel: siteConfig.tiers.premium.label,
  interval: "annual" as const,
  renewsOn: new Date("2027-10-12T09:00:00Z"),
};

describe("renewalReminder", () => {
  it("has a subject and a body for every offset the job sends", () => {
    for (const offsetDays of REMINDER_OFFSETS) {
      const mail = renewalReminder({ ...data, offsetDays });
      expect(mail.subject.length).toBeGreaterThan(10);
      expect(mail.html).toContain("The Old Mill");
      expect(mail.text).toContain("The Old Mill");
    }
  });

  it("says the date, not just the number of days", () => {
    // "in 30 days" in an email read a week late is worse than no reminder.
    const mail = renewalReminder({ ...data, offsetDays: 30 });
    expect(mail.text).toMatch(/12 October 2027/);
  });

  it("reads differently on the day from a month out", () => {
    const far = renewalReminder({ ...data, offsetDays: 30 }).subject;
    const today = renewalReminder({ ...data, offsetDays: 0 }).subject;
    expect(far).not.toBe(today);
  });

  it("always says how to stop it, because the email is about money", () => {
    for (const offsetDays of REMINDER_OFFSETS) {
      expect(renewalReminder({ ...data, offsetDays }).text).toContain(data.billingUrl);
    }
  });

  it("escapes a name that contains markup", () => {
    const mail = renewalReminder({ ...data, listingName: "<script>x</script>", offsetDays: 7 });
    expect(mail.html).not.toContain("<script>");
  });
});
