import { describe, expect, it } from "vitest";
import {
  claimableDomain,
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

  it("matches a mail domain that sits under the listing's own domain", () => {
    expect(matchesListingDomain("https://example.com", "jo@mail.example.com")).toBe(true);
  });

  it("refuses the parent direction, because shared hosting is not ownership", () => {
    // The listing is a tenant of a platform. Anyone at the platform's apex
    // would otherwise be able to take over every tenant's page.
    expect(matchesListingDomain("https://jane.wixsite.com/jane-cakes", "mallory@wixsite.com")).toBe(false);
    expect(matchesListingDomain("https://sites.google.com/view/jane-cakes", "mallory@google.com")).toBe(false);
    // Same rule with nothing shared about it: a subdomain does not vouch for
    // its parent, only the other way round.
    expect(matchesListingDomain("https://bookings.example.com", "jo@example.com")).toBe(false);
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

describe("claimableDomain", () => {
  it("is the listing's domain when the rung can actually decide anything", () => {
    expect(claimableDomain("https://www.example.co.uk/about")).toBe("example.co.uk");
  });

  it("is null for a free-mail domain, because the rung would refuse every address", () => {
    // A listing whose `website` column holds a Gmail address must not be shown
    // a box that can only ever say no.
    expect(claimableDomain("https://gmail.com")).toBeNull();
    expect(claimableDomain("mail.proton.me")).toBeNull();
  });

  it("is null when there is no domain at all", () => {
    expect(claimableDomain(null)).toBeNull();
    expect(claimableDomain("javascript:alert(1)")).toBeNull();
  });
});
