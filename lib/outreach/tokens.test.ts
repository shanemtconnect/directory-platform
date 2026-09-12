import { describe, it, expect } from "vitest";
import { magicToken, couponCode, COUPON_ALPHABET } from "./tokens";

describe("magicToken", () => {
  it("is long, url-safe and unguessable", () => {
    const token = magicToken();
    // 32 bytes of base64url. Guessing one is how an unclaimed listing gets
    // claimed by a stranger, so it is a secret, not an identifier.
    expect(token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
  });

  it("never repeats", () => {
    const seen = new Set(Array.from({ length: 500 }, () => magicToken()));
    expect(seen.size).toBe(500);
  });
});

describe("couponCode", () => {
  it("reads back over the phone without ambiguity", () => {
    const code = couponCode("SAVE50");
    expect(code).toMatch(/^SAVE50-[A-Z0-9]{6}$/);
    // No 0/O, 1/I/L — a code someone mistypes is a discount they do not get.
    expect(code.split("-")[1]).not.toMatch(/[01OIL]/);
    for (const ch of COUPON_ALPHABET) expect("01OIL").not.toContain(ch);
  });

  it("is essentially unique across a batch", () => {
    const seen = new Set(Array.from({ length: 2000 }, () => couponCode("SAVE50")));
    expect(seen.size).toBeGreaterThan(1990);
  });

  it("slugifies and upper-cases the prefix", () => {
    expect(couponCode("save 50%")).toMatch(/^SAVE-50-[A-Z0-9]{6}$/);
  });
});
