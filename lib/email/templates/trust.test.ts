import { describe, it, expect } from "vitest";
import { siteConfig } from "@/config/site.config";
import { REMOVAL_SLA_WORKING_DAYS } from "@/lib/trust/working-days";
import type { EmailContent } from "./layout";
import {
  removalActioned,
  removalReceived,
  removalRejected,
  removalToAdmin,
  reportToAdmin,
} from "./trust";

const report = {
  listingName: "The Old Mill",
  listingUrl: "https://example.co.uk/bath/the-old-mill",
  reason: "closed" as const,
  detail: "They shut in March and the sign has gone.",
  reporterEmail: "spotter@example.co.uk",
  reviewUrl: "https://example.co.uk/admin",
};

const removal = {
  listingName: "The Old Mill",
  listingUrl: "https://example.co.uk/bath/the-old-mill",
  requester: { name: "Alex Owner", email: "alex@example.co.uk" },
  relationship: "owner" as const,
  reason: "I never asked to be listed.",
  dueAt: new Date("2026-06-19T10:00:00Z"),
  reviewUrl: "https://example.co.uk/admin",
};

const decision = {
  listingName: "The Old Mill",
  requesterName: "Alex Owner",
};

const every: [string, EmailContent][] = [
  ["reportToAdmin", reportToAdmin(report)],
  ["removalToAdmin", removalToAdmin(removal)],
  ["removalReceived", removalReceived(removal)],
  ["removalActioned", removalActioned(decision)],
  ["removalRejected", removalRejected(decision)],
];

describe.each(every)("%s", (_name, content) => {
  it("names the site so the recipient knows who is writing", () => {
    expect(content.subject + content.html + content.text).toContain(siteConfig.name);
  });

  it("has a subject, an HTML body and a plain-text body", () => {
    expect(content.subject.length).toBeGreaterThan(0);
    expect(content.html).toContain("<html");
    expect(content.text.length).toBeGreaterThan(0);
  });

  it("interpolates nothing as undefined, null or [object Object]", () => {
    const all = `${content.subject}\n${content.html}\n${content.text}`;
    expect(all).not.toMatch(/undefined|\bnull\b|\[object Object\]/);
  });

  it("offers a way to reach us", () => {
    expect(content.text).toContain(siteConfig.supportEmail);
  });
});

describe("reportToAdmin", () => {
  const content = reportToAdmin(report);

  it("says which listing, what is wrong and where to look", () => {
    expect(content.text).toContain("The Old Mill");
    expect(content.text).toContain("They shut in March");
    expect(content.text).toContain(report.listingUrl);
  });

  it("describes the reason in words rather than as an enum value", () => {
    expect(content.text).toContain("closed");
    expect(content.text).not.toMatch(/^Reason: closed$/m);
  });

  it("replies to the reporter when there is one to reply to", () => {
    expect(content.replyTo).toBe("spotter@example.co.uk");
  });

  it("survives a report with no email and no detail", () => {
    const anonymous = reportToAdmin({ ...report, reporterEmail: null, detail: null });
    expect(anonymous.replyTo).toBeUndefined();
    expect(`${anonymous.subject}\n${anonymous.html}\n${anonymous.text}`)
      .not.toMatch(/undefined|\bnull\b/);
  });

  it("escapes a detail that tries to close a tag", () => {
    const nasty = reportToAdmin({ ...report, detail: "<script>alert(1)</script>" });
    expect(nasty.html).not.toContain("<script>alert(1)</script>");
    expect(nasty.html).toContain("&lt;script&gt;");
  });
});

describe("removalToAdmin", () => {
  const content = removalToAdmin(removal);

  it("carries who asked, on what footing, and the deadline", () => {
    expect(content.text).toContain("Alex Owner");
    expect(content.text).toContain("alex@example.co.uk");
    expect(content.text).toContain(`own the ${siteConfig.entity.singular}`);
    expect(content.text).toContain("19 June 2026");
  });

  it("survives a request with no reason, which we never require", () => {
    const bare = removalToAdmin({ ...removal, reason: null });
    expect(`${bare.subject}\n${bare.html}\n${bare.text}`).not.toMatch(/undefined|\bnull\b/);
  });
});

describe("removalReceived", () => {
  const content = removalReceived(removal);

  it("states the SLA the site promises, in working days", () => {
    expect(content.text).toContain(`${REMOVAL_SLA_WORKING_DAYS} working days`);
    expect(content.text).toContain("19 June 2026");
  });

  it("does not repeat the requester's reason back at them", () => {
    // It is their own text and the copy is an acknowledgement, not a receipt
    // for a transaction. Quoting it adds nothing and spreads the data further.
    expect(content.text).not.toContain("I never asked to be listed.");
  });

  it("names the listing it is about", () => {
    expect(content.text).toContain("The Old Mill");
  });
});

describe("removalActioned", () => {
  const content = removalActioned(decision);

  it("tells the requester the listing is gone", () => {
    expect(content.text).toContain("The Old Mill");
    expect(content.text).toMatch(/removed|taken down/i);
  });

  it("escapes a requester name that tries to close a tag", () => {
    const nasty = removalActioned({ ...decision, requesterName: "<script>alert(1)</script>" });
    expect(nasty.html).not.toContain("<script>alert(1)</script>");
    expect(nasty.html).toContain("&lt;script&gt;");
  });
});

describe("removalRejected", () => {
  const content = removalRejected(decision);

  it("tells the requester the request was not actioned", () => {
    expect(content.text).toContain("The Old Mill");
    expect(content.text).not.toMatch(/we have removed|taken down/i);
  });

  it("gives them a way to come back to us", () => {
    expect(content.text).toContain(siteConfig.supportEmail);
  });

  it("escapes a requester name that tries to close a tag", () => {
    const nasty = removalRejected({ ...decision, requesterName: "<script>alert(1)</script>" });
    expect(nasty.html).not.toContain("<script>alert(1)</script>");
    expect(nasty.html).toContain("&lt;script&gt;");
  });
});
