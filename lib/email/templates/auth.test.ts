import { describe, expect, it } from "vitest";
import { siteConfig } from "@/config/site.config";
import { passwordReset, verifyEmailAddress } from "./auth";

const URL_WITH_TOKEN = "https://example.test/reset-password?token=abc123";

describe("passwordReset", () => {
  it("puts the link in both the HTML and the plain-text part", () => {
    const mail = passwordReset({ name: "Sam", url: URL_WITH_TOKEN, expiresInMinutes: 60 });
    expect(mail.html).toContain(URL_WITH_TOKEN);
    expect(mail.text).toContain(URL_WITH_TOKEN);
  });

  it("says how long the link lasts, because an expired link reads as a broken site", () => {
    const mail = passwordReset({ name: "Sam", url: URL_WITH_TOKEN, expiresInMinutes: 60 });
    expect(mail.text).toContain("60 minutes");
  });

  it("tells somebody who did not ask that they can ignore it", () => {
    // A reset email is the one transactional email a stranger can cause to be
    // sent to you, so it has to say what to do about that.
    const mail = passwordReset({ name: "Sam", url: URL_WITH_TOKEN, expiresInMinutes: 60 });
    expect(mail.text.toLowerCase()).toContain("ignore");
  });

  it("escapes a name, which is user input rendered in somebody's mail client", () => {
    const mail = passwordReset({
      name: '<img src=x onerror="alert(1)">',
      url: URL_WITH_TOKEN,
      expiresInMinutes: 60,
    });
    expect(mail.html).not.toContain("<img");
    expect(mail.html).toContain("&lt;img");
  });

  it("carries no niche wording of its own", () => {
    const mail = passwordReset({ name: "Sam", url: URL_WITH_TOKEN, expiresInMinutes: 60 });
    expect(mail.subject).toContain(siteConfig.name);
  });
});

describe("verifyEmailAddress", () => {
  it("puts the link in both parts", () => {
    const url = "https://example.test/api/auth/verify-email?token=xyz";
    const mail = verifyEmailAddress({ name: "Sam", url, expiresInMinutes: 60 });
    expect(mail.html).toContain(url);
    expect(mail.text).toContain(url);
  });

  it("does not threaten the account, because signing in does not depend on it", () => {
    // requireEmailVerification is false: an unverified owner can still sign in
    // and still claim. Copy that says "verify or lose access" would be a lie.
    const mail = verifyEmailAddress({ name: "Sam", url: "https://x.test/v", expiresInMinutes: 60 });
    expect(mail.text.toLowerCase()).not.toContain("suspend");
    expect(mail.text.toLowerCase()).not.toContain("deleted");
  });

  it("escapes the name", () => {
    const mail = verifyEmailAddress({
      name: "<b>x</b>",
      url: "https://x.test/v",
      expiresInMinutes: 60,
    });
    expect(mail.html).not.toContain("<b>x</b>");
  });
});
