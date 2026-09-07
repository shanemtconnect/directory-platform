import { describe, it, expect } from "vitest";
import { COUNTRY_PROFILES, countryProfile, isSupportedCountry, validatePostcode, normalisePostcode } from "./countries";

describe("country profiles", () => {
  it("supports GB, US, AU and CA", () => {
    for (const c of ["GB", "US", "AU", "CA"]) expect(isSupportedCountry(c)).toBe(true);
  });

  it("rejects an unsupported country code", () => {
    expect(isSupportedCountry("XX")).toBe(false);
    expect(() => countryProfile("XX")).toThrow(/unsupported/i);
  });

  it("labels the region correctly per country", () => {
    expect(countryProfile("GB").regionLabel).toBe("county");
    expect(countryProfile("US").regionLabel).toBe("state");
    expect(countryProfile("CA").regionLabel).toBe("province");
    expect(countryProfile("AU").regionLabel).toBe("state");
  });

  it("labels the postal code correctly per country", () => {
    expect(countryProfile("GB").postcodeLabel).toBe("postcode");
    expect(countryProfile("US").postcodeLabel).toBe("ZIP code");
    expect(countryProfile("CA").postcodeLabel).toBe("postal code");
  });

  it("carries the right spelling variant, so UI copy is not transatlantic", () => {
    expect(countryProfile("GB").spelling).toBe("en-GB");
    expect(countryProfile("US").spelling).toBe("en-US");
    expect(countryProfile("CA").spelling).toBe("en-US");
    expect(countryProfile("AU").spelling).toBe("en-GB");
  });
});

describe("validatePostcode", () => {
  it("accepts real UK postcodes in either spacing", () => {
    for (const p of ["SW1A 1AA", "sw1a1aa", "M1 1AE", "LS1 4DY", "GY1 1WR", "JE2 3QA"]) {
      expect(validatePostcode("GB", p)).toBe(true);
    }
  });

  it("rejects a US ZIP as a UK postcode", () => {
    expect(validatePostcode("GB", "90210")).toBe(false);
  });

  it("accepts 5-digit and ZIP+4 US codes", () => {
    expect(validatePostcode("US", "90210")).toBe(true);
    expect(validatePostcode("US", "90210-1234")).toBe(true);
  });

  it("rejects a UK postcode as a US ZIP", () => {
    expect(validatePostcode("US", "SW1A 1AA")).toBe(false);
  });

  it("accepts Canadian postal codes and Australian 4-digit codes", () => {
    expect(validatePostcode("CA", "K1A 0B1")).toBe(true);
    expect(validatePostcode("CA", "k1a0b1")).toBe(true);
    expect(validatePostcode("AU", "2000")).toBe(true);
    expect(validatePostcode("AU", "200")).toBe(false);
  });
});

describe("normalisePostcode", () => {
  it("strips spacing and case for matching", () => {
    expect(normalisePostcode("SW1A 1AA")).toBe("sw1a1aa");
    expect(normalisePostcode(" k1a 0b1 ")).toBe("k1a0b1");
  });

  it("matches two spellings of the same code, which is what suppression relies on", () => {
    expect(normalisePostcode("LS1 1AA")).toBe(normalisePostcode("ls11aa"));
  });
});
