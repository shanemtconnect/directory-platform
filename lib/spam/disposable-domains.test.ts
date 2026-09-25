import { describe, expect, it } from "vitest";
import { DISPOSABLE_DOMAINS, isDisposableEmail } from "./disposable-domains";

describe("isDisposableEmail", () => {
  it.each([
    "someone@mailinator.com",
    "SOMEONE@Mailinator.COM",
    "  a@guerrillamail.com  ",
    "x@10minutemail.com",
    "x@yopmail.com",
    "x@temp-mail.org",
    // a subdomain of a listed domain is the same service
    "x@eu.mailinator.com",
  ])("refuses %s", (email) => {
    expect(isDisposableEmail(email)).toBe(true);
  });

  it.each([
    "someone@gmail.com",
    "someone@example.co.uk",
    "someone@notmailinator.com",
    "someone@mailinator.com.example.org",
    "no-at-sign",
    "",
  ])("accepts %s", (email) => {
    expect(isDisposableEmail(email)).toBe(false);
  });

  it("is a list of about sixty lower-case bare domains with no duplicates", () => {
    expect(DISPOSABLE_DOMAINS.length).toBeGreaterThanOrEqual(55);
    expect(new Set(DISPOSABLE_DOMAINS).size).toBe(DISPOSABLE_DOMAINS.length);
    for (const d of DISPOSABLE_DOMAINS) expect(d).toMatch(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/);
  });
});
