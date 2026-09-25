import { describe, expect, it } from "vitest";
import { MAX_ADJUST_CENTS, parseCreditAmount } from "./format";

describe("parseCreditAmount", () => {
  it("reads a signed decimal of at most two places as whole cents, exactly", () => {
    expect(parseCreditAmount("10")).toBe(1000);
    expect(parseCreditAmount(" -10.5 ")).toBe(-1050);
    expect(parseCreditAmount("0.07")).toBe(7);
    expect(parseCreditAmount("+2.10")).toBe(210);
    expect(parseCreditAmount("100000")).toBe(MAX_ADJUST_CENTS);
  });

  it("refuses sub-penny, non-numeric, empty and out-of-range input rather than rounding it", () => {
    for (const bad of ["10.005", "0.001", "abc", "", " ", "1e5", "10,00", "--1", "1.", ".5x", "100000.01", "-100001", "99999999999999999999"]) {
      expect(parseCreditAmount(bad), bad).toBeNull();
    }
  });
});
