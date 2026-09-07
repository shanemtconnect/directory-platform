import { describe, it, expect } from "vitest";
import { slugify, isReserved, RESERVED_SLUGS } from "./slugify";

describe("slugify", () => {
  it("lowercases and hyphenates", () => {
    expect(slugify("Milton Keynes")).toBe("milton-keynes");
  });

  it("strips accents", () => {
    expect(slugify("Ynys Môn")).toBe("ynys-mon");
    expect(slugify("Saint-Étienne")).toBe("saint-etienne");
  });

  it("strips apostrophes rather than hyphenating them", () => {
    expect(slugify("St Ouen's Manor")).toBe("st-ouens-manor");
    expect(slugify("St Ouen’s Manor")).toBe("st-ouens-manor");
  });

  it("collapses runs of separators and trims them", () => {
    expect(slugify("  The  Barn -- & Co.  ")).toBe("the-barn-co");
  });

  it("treats an ampersand as a boundary, not a word", () => {
    expect(slugify("Bath & North East Somerset")).toBe("bath-north-east-somerset");
  });

  it("keeps digits", () => {
    expect(slugify("Studio 54")).toBe("studio-54");
  });

  it("returns an empty string when there is nothing slug-able", () => {
    expect(slugify("!!!")).toBe("");
    expect(slugify("   ")).toBe("");
    expect(slugify("")).toBe("");
  });

  it("is idempotent", () => {
    const once = slugify("Stoke-on-Trent");
    expect(slugify(once)).toBe(once);
  });
});

describe("isReserved", () => {
  it("catches every reserved slug", () => {
    for (const s of RESERVED_SLUGS) expect(isReserved(s)).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isReserved("ADMIN")).toBe(true);
  });

  it("allows an ordinary city slug", () => {
    expect(isReserved("manchester")).toBe(false);
  });

  it("reserves flagged route segments even when their flag is off", () => {
    // A city called "Awards" must be rejected on a site where awards is off,
    // or turning the flag on later breaks a live URL.
    for (const s of ["awards", "jobs", "cost", "shortlist", "guides", "tools"]) {
      expect(isReserved(s)).toBe(true);
    }
  });
});
