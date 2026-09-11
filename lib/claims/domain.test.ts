import { describe, expect, it } from "vitest";
import {
  domainOfEmail,
  domainOfWebsite,
  isFreeMailDomain,
  matchesListingDomain,
} from "./domain";

describe("domainOfWebsite", () => {
  it("takes the host out of a URL and drops www", () => {
    expect(domainOfWebsite("https://www.example.co.uk/about?x=1")).toBe("example.co.uk");
  });

  it("copes with a bare host that has no scheme", () => {
    expect(domainOfWebsite("Example.COM")).toBe("example.com");
  });

  it("returns null for anything that is not a host", () => {
    expect(domainOfWebsite(null)).toBeNull();
    expect(domainOfWebsite("   ")).toBeNull();
    expect(domainOfWebsite("not a domain")).toBeNull();
    // A scheme we would never send anyone to.
    expect(domainOfWebsite("javascript:alert(1)")).toBeNull();
  });
});

describe("domainOfEmail", () => {
  it("takes the part after the last @, lowercased", () => {
    expect(domainOfEmail("Jo.Bloggs@Example.com")).toBe("example.com");
  });

  it("returns null when there is no single sensible domain", () => {
    expect(domainOfEmail("nobody")).toBeNull();
    expect(domainOfEmail("@example.com")).toBeNull();
    expect(domainOfEmail("a@")).toBeNull();
  });
});

describe("isFreeMailDomain", () => {
  it("knows the mailbox providers anybody can sign up to", () => {
    for (const d of ["gmail.com", "googlemail.com", "yahoo.co.uk", "hotmail.com", "outlook.com", "icloud.com", "proton.me"]) {
      expect(isFreeMailDomain(d), d).toBe(true);
    }
  });

  it("does not treat a business domain as free mail", () => {
    expect(isFreeMailDomain("example.co.uk")).toBe(false);
  });
});

describe("matchesListingDomain", () => {
  it("matches an exact domain", () => {
    expect(matchesListingDomain("https://www.example.co.uk", "jo@example.co.uk")).toBe(true);
  });

  it("matches a subdomain in either direction", () => {
    expect(matchesListingDomain("https://example.com", "jo@mail.example.com")).toBe(true);
    expect(matchesListingDomain("https://bookings.example.com", "jo@example.com")).toBe(true);
  });

  it("never matches on a free-mail domain, even when the website is one", () => {
    expect(matchesListingDomain("https://www.example.com", "jo@gmail.com")).toBe(false);
    // A listing whose "website" is a Gmail address must not hand ownership to
    // every Gmail user on the internet.
    expect(matchesListingDomain("https://gmail.com", "jo@gmail.com")).toBe(false);
  });

  it("does not match a domain that merely ends with the same characters", () => {
    expect(matchesListingDomain("https://example.com", "jo@notexample.com")).toBe(false);
    expect(matchesListingDomain("https://example.com", "jo@example.com.evil.net")).toBe(false);
  });

  it("is false when either side is missing", () => {
    expect(matchesListingDomain(null, "jo@example.com")).toBe(false);
    expect(matchesListingDomain("https://example.com", "")).toBe(false);
  });
});
