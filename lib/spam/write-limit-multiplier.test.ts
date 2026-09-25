import { describe, expect, it } from "vitest";
import { writeLimitMultiplier } from "./write-limit";

describe("PUBLIC_WRITE_LIMIT_MULTIPLIER", () => {
  it("is 1 when unset, empty or not a whole number of at least 1", () => {
    expect(writeLimitMultiplier({})).toBe(1);
    expect(writeLimitMultiplier({ PUBLIC_WRITE_LIMIT_MULTIPLIER: "" })).toBe(1);
    expect(writeLimitMultiplier({ PUBLIC_WRITE_LIMIT_MULTIPLIER: "0" })).toBe(1);
    expect(writeLimitMultiplier({ PUBLIC_WRITE_LIMIT_MULTIPLIER: "1.5" })).toBe(1);
    expect(writeLimitMultiplier({ PUBLIC_WRITE_LIMIT_MULTIPLIER: "lots" })).toBe(1);
  });

  it("scales the budgets by a whole number", () => {
    expect(writeLimitMultiplier({ PUBLIC_WRITE_LIMIT_MULTIPLIER: "20" })).toBe(20);
  });
});
