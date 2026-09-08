import { describe, it, expect } from "vitest";
import { siteConfig } from "@/config/site.config";
import { escapeHtml } from "./layout";
import { enquiryToOwner, enquiryToAdmin } from "./enquiry";
import { submissionToAdmin, submissionReceived } from "./submission";
import type { EmailContent } from "./layout";

const enquiry = {
  listingName: "The Old Mill",
  listingUrl: "https://example.co.uk/bath/the-old-mill",
  from: { name: "Sam Enquirer", email: "sam@example.co.uk", phone: "01632 960000" },
  message: "We are looking for somewhere for about eighty people in June.",
};

const submission = {
  listingName: "The Old Mill",
  cityName: "Bath",
  submitter: { name: "Alex Owner", email: "alex@example.co.uk" },
  reviewUrl: "https://example.co.uk/admin/listings/1",
};

const every: [string, EmailContent][] = [
  ["enquiryToOwner", enquiryToOwner(enquiry)],
  ["enquiryToAdmin", enquiryToAdmin(enquiry)],
  ["submissionToAdmin", submissionToAdmin(submission)],
  ["submissionReceived", submissionReceived(submission)],
];

describe("escapeHtml", () => {
  it("neutralises the characters that would close a tag or an attribute", () => {
    expect(escapeHtml(`<script>"x"&'y'`)).toBe(
      "&lt;script&gt;&quot;x&quot;&amp;&#39;y&#39;",
    );
  });
});

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

describe("enquiryToOwner", () => {
  const content = enquiryToOwner(enquiry);

  it("uses the entity noun from siteConfig rather than a hardcoded one", () => {
    expect(content.subject).toContain(siteConfig.entity.singular);
  });

  it("carries the enquiry so the owner can answer without logging in", () => {
    expect(content.text).toContain("Sam Enquirer");
    expect(content.text).toContain("sam@example.co.uk");
    expect(content.text).toContain("01632 960000");
    expect(content.text).toContain("about eighty people in June");
    expect(content.text).toContain(enquiry.listingUrl);
  });

  it("replies to the enquirer, not to us", () => {
    expect(content.replyTo).toBe("sam@example.co.uk");
  });

  it("says nothing about a phone number when there is none", () => {
    const noPhone = enquiryToOwner({ ...enquiry, from: { ...enquiry.from, phone: null } });
    expect(noPhone.text).not.toContain("01632");
    expect(`${noPhone.html}${noPhone.text}`).not.toContain("undefined");
  });

  it("escapes the enquirer's text so a message cannot inject markup", () => {
    const nasty = enquiryToOwner({
      ...enquiry,
      from: { ...enquiry.from, name: "<script>alert(1)</script>" },
      message: "<img src=x onerror=alert(1)>",
    });
    expect(nasty.html).not.toContain("<script>");
    expect(nasty.html).not.toContain("<img");
    expect(nasty.html).toContain("&lt;script&gt;");
  });
});

describe("enquiryToAdmin", () => {
  it("subjects the listing so the inbox is sortable, and replies to the enquirer", () => {
    const content = enquiryToAdmin(enquiry);
    expect(content.subject).toContain("The Old Mill");
    expect(content.replyTo).toBe("sam@example.co.uk");
  });
});

describe("submissionToAdmin", () => {
  it("names the submitter and links the review page", () => {
    const content = submissionToAdmin(submission);
    expect(content.text).toContain("Alex Owner");
    expect(content.text).toContain("alex@example.co.uk");
    expect(content.text).toContain(submission.reviewUrl);
    expect(content.text).toContain("Bath");
  });

  it("says the submission is parked when the town is not one we hold", () => {
    const content = submissionToAdmin({ ...submission, cityName: null });
    expect(content.text).toContain("parked queue");
    expect(`${content.subject}${content.html}${content.text}`).not.toMatch(
      /undefined|\bnull\b/,
    );
  });
});

describe("submissionReceived", () => {
  it("tells the submitter what happens next without promising publication", () => {
    const content = submissionReceived(submission);
    expect(content.text).toContain("Alex Owner");
    expect(content.text).toContain("The Old Mill");
    expect(content.subject).toContain(siteConfig.name);
  });
});
