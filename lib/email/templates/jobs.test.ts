import { describe, expect, it } from "vitest";
import { jobApproved, jobExpiring, jobRejected, jobSubmittedToAdmin } from "./jobs";

const decided = {
  title: "Weekend coordinator",
  posterName: "Pat",
  jobUrl: "https://example.test/jobs/abc",
  closesOn: new Date("2026-10-22T10:00:00Z"),
  reason: null,
};

describe("jobs board emails", () => {
  it("tells the admin what is waiting and whether it was paid for", () => {
    const paid = jobSubmittedToAdmin({
      title: "Weekend coordinator",
      companyName: "The Old Mill",
      cityName: "Leeds",
      posterName: "Pat",
      posterEmail: "pat@example.co.uk",
      paid: true,
      reviewUrl: "https://example.test/admin/jobs",
    });
    expect(paid.subject).toContain("Weekend coordinator");
    expect(paid.text).toContain("has paid");
    expect(paid.text).toContain("https://example.test/admin/jobs");
    expect(paid.replyTo).toBe("pat@example.co.uk");

    const free = jobSubmittedToAdmin({
      title: "T", companyName: null, cityName: null, posterName: null, posterEmail: null, paid: false, reviewUrl: "u",
    });
    expect(free.text).toContain("Verified");
    expect(free.replyTo).toBeUndefined();
  });

  it("says the closing DATE on approval, and the reason on rejection", () => {
    const yes = jobApproved(decided);
    expect(yes.text).toMatch(/22 October 2026/);
    expect(yes.text).toContain("https://example.test/jobs/abc");
    const no = jobRejected({ ...decided, reason: "Not a real vacancy." });
    expect(no.text).toContain("Not a real vacancy.");
    expect(no.text).not.toContain("live");
  });

  it("escapes what the poster typed", () => {
    const mail = jobRejected({ ...decided, reason: "<script>alert(1)</script>" });
    expect(mail.html).not.toContain("<script>");
    expect(mail.html).toContain("&lt;script&gt;");
  });

  it("the reminder names the date and the way to post again", () => {
    const mail = jobExpiring({
      title: "Weekend coordinator",
      posterName: null,
      jobUrl: "https://example.test/jobs/abc",
      closesOn: new Date("2026-10-22T10:00:00Z"),
      postUrl: "https://example.test/post-a-job",
    });
    expect(mail.subject).toMatch(/22 October 2026/);
    expect(mail.text).toContain("https://example.test/post-a-job");
  });
});
