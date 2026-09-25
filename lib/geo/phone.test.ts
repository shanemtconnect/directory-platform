import { describe, expect, it } from "vitest";
import { normalisePhone } from "./phone";

describe("normalisePhone", () => {
  it.each([
    // GB: national, international and 00 forms of the same number
    ["GB", "020 7946 0018", "+442079460018"],
    ["GB", "+44 20 7946 0018", "+442079460018"],
    ["GB", "0044 (0)20 7946 0018", "+442079460018"],
    ["GB", "07700 900123", "+447700900123"],
    ["GB", "01632 960000", "+441632960000"],
    ["GB", "0800 123 4567", "+448001234567"],
    ["GB", "0808-157-0192", "+448081570192"],
    ["GB", "(01632) 960.001", "+441632960001"],
    // US: ten digits, with or without the 1
    ["US", "(212) 555-0199", null], // 555-01xx is the fiction range
    ["US", "(212) 456-7890", "+12124567890"],
    ["US", "+1 212 456 7890", "+12124567890"],
    ["US", "1-212-456-7890", "+12124567890"],
    // AU
    ["AU", "(02) 9374 4000", "+61293744000"],
    ["AU", "0412 345 678", "+61412345678"],
    ["AU", "+61 412 345 678", "+61412345678"],
    ["AU", "1800 123 456", "+611800123456"],
  ])("%s %s -> %s", (country, raw, expected) => {
    expect(normalisePhone(raw, country)).toBe(expected);
  });

  it.each([
    // premium and personal-numbering ranges
    ["GB", "0909 879 0000"],
    ["GB", "09 1234 5678"],
    ["GB", "070 1234 5678"],
    ["US", "(900) 456-7890"],
    ["US", "+1 900 456 7890"],
    ["US", "(212) 555-0100"],
    ["US", "212 555 0142"],
    ["AU", "1900 123 456"],
    ["AU", "1902 123 456"],
    // too short, too long
    ["GB", "020 7946"],
    ["GB", "020 7946 0018 99"],
    ["US", "456-7890"],
    ["AU", "0412 345"],
    // letters and junk
    ["GB", "020 7946 CALL"],
    ["GB", "phone me"],
    ["US", "212-456-78ab"],
    ["GB", ""],
    ["GB", "   "],
    // unassigned leading digits
    ["GB", "040 1234 5678"],
    ["US", "(112) 456-7890"],
    ["US", "(212) 056-7890"],
    // another country's number on this site
    ["GB", "+1 212 456 7890"],
    ["US", "+44 20 7946 0018"],
  ])("%s %s -> null", (country, raw) => {
    expect(normalisePhone(raw, country)).toBeNull();
  });

  it("treats CA as the North American plan it shares with the US", () => {
    expect(normalisePhone("(416) 456-7890", "CA")).toBe("+14164567890");
    expect(normalisePhone("(416) 555-0123", "CA")).toBeNull();
  });

  it("accepts null and undefined as no number", () => {
    expect(normalisePhone(null, "GB")).toBeNull();
    expect(normalisePhone(undefined, "GB")).toBeNull();
  });
});
