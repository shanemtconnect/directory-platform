import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { normaliseAddress, signUnsubscribe, unsubscribeUrl, verifyUnsubscribe } from "./unsubscribe";

const ENV = { ...process.env };

beforeEach(() => {
  process.env.EMAIL_UNSUBSCRIBE_SECRET = "unit-test-secret";
  process.env.NEXT_PUBLIC_SITE_URL = "https://example.co.uk";
});
afterEach(() => {
  process.env = { ...ENV };
});

const claim = { email: "Owner@Example.com", listingId: "33333333-3333-4333-8333-333333333333" };

describe("unsubscribe tokens", () => {
  it("round-trips the address and listing", () => {
    const token = signUnsubscribe(claim);
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(verifyUnsubscribe(token)).toEqual(claim);
  });

  it("refuses a tampered payload, a tampered signature, and junk", () => {
    const token = signUnsubscribe(claim)!;
    const [payload, sig] = token.split(".") as [string, string];
    const other = signUnsubscribe({ ...claim, email: "victim@example.com" })!.split(".")[0]!;
    expect(verifyUnsubscribe(`${other}.${sig}`)).toBeNull();
    expect(verifyUnsubscribe(`${payload}.${sig.slice(0, -1)}x`)).toBeNull();
    expect(verifyUnsubscribe(`${payload}.`)).toBeNull();
    expect(verifyUnsubscribe(payload)).toBeNull();
    expect(verifyUnsubscribe("")).toBeNull();
    expect(verifyUnsubscribe(null)).toBeNull();
  });

  it("is bound to the key: a token from one secret fails under another", () => {
    const token = signUnsubscribe(claim);
    process.env.EMAIL_UNSUBSCRIBE_SECRET = "a-different-secret";
    expect(verifyUnsubscribe(token)).toBeNull();
  });

  it("falls back to BETTER_AUTH_SECRET and mints nothing with neither", () => {
    delete process.env.EMAIL_UNSUBSCRIBE_SECRET;
    process.env.BETTER_AUTH_SECRET = "auth-secret";
    expect(verifyUnsubscribe(signUnsubscribe(claim))).toEqual(claim);
    delete process.env.BETTER_AUTH_SECRET;
    expect(signUnsubscribe(claim)).toBeNull();
  });

  it("builds the absolute link and normalises like the readers do", () => {
    expect(unsubscribeUrl("a.b")).toBe("https://example.co.uk/unsubscribe?t=a.b");
    expect(normaliseAddress("  Owner@Example.com ")).toBe("owner@example.com");
  });
});
