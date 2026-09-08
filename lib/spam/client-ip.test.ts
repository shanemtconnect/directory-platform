import { describe, it, expect } from "vitest";
import { clientIp, rateLimitSubject } from "./client-ip";

const h = (init: Record<string, string>) => new Headers(init);

describe("clientIp", () => {
  it("takes the LAST X-Forwarded-For hop, the one our own proxy appended", () => {
    // Everything to the left of the last entry is whatever the client sent.
    // Trusting it lets one attacker spend the whole world's rate limit.
    expect(clientIp(h({ "x-forwarded-for": "203.0.113.9, 198.51.100.4" }))).toBe("198.51.100.4");
  });

  it("returns the only hop when there is just one", () => {
    expect(clientIp(h({ "x-forwarded-for": "198.51.100.4" }))).toBe("198.51.100.4");
  });

  it("ignores surrounding space and trailing empty entries", () => {
    expect(clientIp(h({ "x-forwarded-for": " 203.0.113.9 ,  198.51.100.4 , " }))).toBe(
      "198.51.100.4",
    );
  });

  it("falls back to X-Real-IP when there is no X-Forwarded-For", () => {
    expect(clientIp(h({ "x-real-ip": "198.51.100.22" }))).toBe("198.51.100.22");
  });

  it("prefers X-Forwarded-For over X-Real-IP", () => {
    expect(
      clientIp(h({ "x-forwarded-for": "198.51.100.4", "x-real-ip": "198.51.100.22" })),
    ).toBe("198.51.100.4");
  });

  it("returns null rather than a placeholder when no proxy header is present", () => {
    expect(clientIp(h({}))).toBeNull();
    expect(clientIp(h({ "x-forwarded-for": "  ,  " }))).toBeNull();
    expect(clientIp(h({ "x-real-ip": "   " }))).toBeNull();
  });
});

describe("rateLimitSubject", () => {
  it("uses the IP when we have one", () => {
    expect(rateLimitSubject("198.51.100.4")).toBe("198.51.100.4");
  });

  it("gives an unidentifiable request its own bucket, never a shared one", () => {
    // The old code bucketed every such request under "unknown", so a single
    // bot could lock out every direct-connection visitor on the site.
    const a = rateLimitSubject(null);
    const b = rateLimitSubject(null);
    expect(a).not.toBe(b);
    expect(a).not.toBe("unknown");
  });
});
