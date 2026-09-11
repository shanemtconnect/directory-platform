import { describe, expect, it } from "vitest";
import { siteConfig } from "@/config/site.config";
import type { EmailContent } from "./layout";
import { claimApproved, claimMagicLink, claimRejected, claimToAdmin } from "./claim";

const listing = {
  listingName: "The Old Mill",
  listingUrl: "https://example.co.uk/bath/the-old-mill",
};

const magic = {
  ...listing,
  verifyUrl: "https://example.co.uk/claim/verify/abc123",
  expiresInMinutes: 30,
};

const every: [string, EmailContent][] = [
  ["claimMagicLink", claimMagicLink(magic)],
  ["claimApproved", claimApproved({ ...listing, dashboardUrl: "https://example.co.uk/account" })],
  ["claimRejected", claimRejected({ ...listing, reason: "The document did not name the business." })],
  ["claimToAdmin", claimToAdmin({
    ...listing,
    claimantName: "Jo Bloggs",
    claimantEmail: "jo@oldmill.example",
    reviewUrl: "https://example.co.uk/admin/claims/1",
  })],
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

  it("uses the entity noun from siteConfig rather than a hardcoded one", () => {
    const all = `${content.subject}\n${content.text}`.toLowerCase();
    expect(all).toContain(siteConfig.entity.singular.toLowerCase());
  });
});

describe("claimMagicLink", () => {
  const content = claimMagicLink(magic);

  it("carries the link and says how long it lasts", () => {
    expect(content.text).toContain(magic.verifyUrl);
    expect(content.text).toContain("30 minutes");
  });

  it("says what to do if the claim was not theirs", () => {
    // The address belongs to the business, not necessarily to the claimant —
    // an unexpected link is the one signal that somebody is trying it on.
    expect(content.text.toLowerCase()).toContain("ignore");
  });

  it("escapes a name so a listing cannot inject markup into the body", () => {
    const nasty = claimMagicLink({ ...magic, listingName: "<script>alert(1)</script>" });
    expect(nasty.html).not.toContain("<script>");
    expect(nasty.html).toContain("&lt;script&gt;");
  });
});

describe("claimRejected", () => {
  it("gives the reason, because a decision with no reason invites a resubmission", () => {
    const content = claimRejected({ ...listing, reason: "The document did not name the business." });
    expect(content.text).toContain("The document did not name the business.");
  });
});

describe("claimApproved", () => {
  it("points at the dashboard the new owner is meant to use next", () => {
    const content = claimApproved({ ...listing, dashboardUrl: "https://example.co.uk/account" });
    expect(content.text).toContain("https://example.co.uk/account");
  });
});

describe("claimToAdmin", () => {
  it("replies to the claimant and links straight to the review screen", () => {
    const content = claimToAdmin({
      ...listing,
      claimantName: "Jo Bloggs",
      claimantEmail: "jo@oldmill.example",
      reviewUrl: "https://example.co.uk/admin/claims/1",
    });
    expect(content.replyTo).toBe("jo@oldmill.example");
    expect(content.text).toContain("https://example.co.uk/admin/claims/1");
  });

  it("copes with a claimant who gave no name", () => {
    const content = claimToAdmin({
      ...listing, claimantName: null, claimantEmail: null,
      reviewUrl: "https://example.co.uk/admin/claims/1",
    });
    expect(`${content.html}${content.text}`).not.toMatch(/undefined|\bnull\b/);
    expect(content.replyTo).toBeUndefined();
  });
});
