import { describe, it, expect, vi } from "vitest";
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

  it("returns null for an unidentifiable request instead of minting a bucket", () => {
    // The old code minted `anon:${randomUUID()}` per call, so with no proxy
    // header every request got a fresh Redis key (or, with Redis down, a
    // fresh in-process Map entry) — an unbounded key generator disguised as
    // a rate limit. There is nothing useful to count against, so: no key.
    expect(rateLimitSubject(null)).toBeNull();
  });

  it("warns once per process, only in production, when no client IP is present", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.resetModules();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const mod = await import("./client-ip");
      mod.rateLimitSubject(null);
      mod.rateLimitSubject(null);
      mod.rateLimitSubject(null);
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it("does not warn outside production", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.resetModules();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const mod = await import("./client-ip");
      mod.rateLimitSubject(null);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});
