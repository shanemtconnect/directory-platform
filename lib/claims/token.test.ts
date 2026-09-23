import { afterEach, describe, expect, it } from "vitest";
import { resetClock, setClock } from "@/lib/clock";
import {
  MAGIC_TOKEN_TTL_MINUTES,
  isTokenExpired,
  magicTokenExpiry,
  newMagicToken,
} from "./token";

afterEach(() => resetClock());

describe("newMagicToken", () => {
  it("is long, URL-safe and never repeats", () => {
    const a = newMagicToken();
    const b = newMagicToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe("magicTokenExpiry", () => {
  it("is 30 minutes after the clock, not after the wall clock", () => {
    setClock(new Date("2026-09-08T12:00:00Z"));
    expect(MAGIC_TOKEN_TTL_MINUTES).toBe(30);
    expect(magicTokenExpiry().toISOString()).toBe("2026-09-08T12:30:00.000Z");
  });
});

describe("isTokenExpired", () => {
  it("is false up to the expiry instant and true after it", () => {
    setClock(new Date("2026-09-08T12:30:00Z"));
    expect(isTokenExpired(new Date("2026-09-08T12:30:00Z"))).toBe(false);
    expect(isTokenExpired(new Date("2026-09-08T12:29:59Z"))).toBe(true);
  });

  it("treats a missing expiry as expired", () => {
    expect(isTokenExpired(null)).toBe(true);
  });
});
