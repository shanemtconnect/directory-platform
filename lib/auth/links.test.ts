import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { authOrigin, passwordResetLink, verifyEmailLink } from "./links";

const ENV = { ...process.env };

beforeEach(() => {
  delete process.env.BETTER_AUTH_URL;
  delete process.env.NEXT_PUBLIC_SITE_URL;
});

afterEach(() => {
  process.env = { ...ENV };
});

describe("authOrigin", () => {
  it("prefers BETTER_AUTH_URL, falls back to NEXT_PUBLIC_SITE_URL, and is an origin only", () => {
    process.env.NEXT_PUBLIC_SITE_URL = "https://public.example/";
    expect(authOrigin()).toBe("https://public.example");
    process.env.BETTER_AUTH_URL = "https://auth.example/some/path";
    expect(authOrigin()).toBe("https://auth.example");
  });

  it("is null when neither is set or the value is not a URL", () => {
    expect(authOrigin()).toBeNull();
    process.env.BETTER_AUTH_URL = "not a url";
    expect(authOrigin()).toBeNull();
  });
});

describe("the two token links", () => {
  beforeEach(() => {
    process.env.BETTER_AUTH_URL = "https://example.co.uk";
  });

  it("land on Better Auth's own handlers under /api/auth with our pages as the callback", () => {
    expect(passwordResetLink("tok_r")).toBe(
      "https://example.co.uk/api/auth/reset-password/tok_r?callbackURL=%2Freset-password",
    );
    expect(verifyEmailLink("tok_v")).toBe(
      "https://example.co.uk/api/auth/verify-email?token=tok_v&callbackURL=%2Fverify-email",
    );
  });

  it("URL-encode the token so it survives the path and the query intact", () => {
    expect(passwordResetLink("a/b?c")).toContain("/reset-password/a%2Fb%3Fc?");
    expect(verifyEmailLink("a&b=c")).toContain("?token=a%26b%3Dc&");
  });

  it("refuse to build a link with no origin configured rather than emit a relative one", () => {
    delete process.env.BETTER_AUTH_URL;
    expect(() => passwordResetLink("t")).toThrow(/origin/i);
    expect(() => verifyEmailLink("t")).toThrow(/origin/i);
  });
});
