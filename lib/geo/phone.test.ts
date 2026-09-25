import { describe, expect, it } from "vitest";
import { FICTIONAL_RANGES, normalisePhone } from "./phone";

describe("normalisePhone", () => {
  it.each([
    // GB: national, international and 00 forms of the same number
    ["GB", "020 7946 1018", "+442079461018"],
    ["GB", "+44 20 7946 1018", "+442079461018"],
    ["GB", "0044 (0)20 7946 1018", "+442079461018"],
    ["GB", "07700 901123", "+447700901123"],
    ["GB", "01632 970000", "+441632970000"],
    ["GB", "0800 123 4567", "+448001234567"],
    ["GB", "0808-157-1192", "+448081571192"],
    ["GB", "(01632) 970.001", "+441632970001"],
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
    ["GB", "020 7946 1018 99"],
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
    ["US", "+44 20 7946 1018"],
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

describe("normalisePhone — the fiction ranges (D11)", () => {
  it.each([
    // Ofcom's numbers reserved for drama, one per published range, first and last.
    ["GB", "01632 960000"], ["GB", "01632 960999"],
    ["GB", "020 7946 0000"], ["GB", "020 7946 0999"],
    ["GB", "07700 900000"], ["GB", "07700 900999"],
    ["GB", "0808 157 0000"], ["GB", "0808 157 0999"],
    ["GB", "0909 879 0000"], ["GB", "0909 879 0999"],
    ["GB", "03069 990000"], ["GB", "03069 990999"],
    ["GB", "0191 498 0000"], ["GB", "0113 496 0000"], ["GB", "0114 496 0999"],
    ["GB", "0115 496 0123"], ["GB", "0116 496 0123"], ["GB", "0117 496 0123"],
    ["GB", "0118 496 0123"], ["GB", "0121 496 0123"], ["GB", "0131 496 0123"],
    ["GB", "0141 496 0123"], ["GB", "0161 496 0123"],
    ["GB", "028 9018 0000"], ["GB", "028 9018 0999"],
    ["GB", "029 2018 0000"], ["GB", "029 2018 0999"],
    ["GB", "+44 20 7946 0018"], ["GB", "0044 (0)7700 900123"],
    // ACMA's numbers reserved for fiction.
    ["AU", "(02) 5550 1234"], ["AU", "(03) 5550 1234"], ["AU", "(07) 5550 1234"], ["AU", "(08) 5550 1234"],
    ["AU", "(02) 7010 1234"], ["AU", "(03) 7010 1234"], ["AU", "(07) 7010 1234"], ["AU", "(08) 7010 1234"],
    ["AU", "0491 570 156"], ["AU", "0491 570 999"],
    ["AU", "1800 160 401"], ["AU", "1900 654 321"],
    ["AU", "+61 491 570 156"],
  ])("%s %s is refused", (country, raw) => {
    expect(normalisePhone(raw, country)).toBeNull();
  });

  it.each([
    // Neighbours just outside each range are ordinary numbers.
    ["GB", "01632 961000", "+441632961000"],
    ["GB", "020 7946 1000", "+442079461000"],
    ["GB", "07700 901000", "+447700901000"],
    ["GB", "0113 496 1000", "+441134961000"],
    ["GB", "028 9018 1000", "+442890181000"],
    ["AU", "(02) 5551 1234", "+61255511234"],
    ["AU", "0491 571 156", "+61491571156"],
    ["AU", "1800 161 401", "+611800161401"],
  ])("%s %s is an ordinary number", (country, raw, expected) => {
    expect(normalisePhone(raw, country)).toBe(expected);
  });

  it("lists every range as a national-number prefix for its country", () => {
    expect(Object.keys(FICTIONAL_RANGES).sort()).toEqual(["AU", "GB"]);
    for (const prefixes of Object.values(FICTIONAL_RANGES)) {
      for (const p of prefixes) expect(p).toMatch(/^[1-9]\d+$/);
    }
  });
});
