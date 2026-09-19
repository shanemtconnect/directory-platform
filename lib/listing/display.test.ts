import { describe, it, expect } from "vitest";
import { displayedDescription, displayedSocials } from "./display";
import type { TierSpec } from "@/config/types";

const free = { descriptionDisplay: "excerpt", excerptChars: 20, showSocial: false } as TierSpec;
const paid = { descriptionDisplay: "full", excerptChars: 20, showSocial: true } as TierSpec;

describe("displayedDescription", () => {
  it("returns the full description on a tier that shows it in full", () => {
    expect(displayedDescription({ description: "A restored barn.", shortDescription: null }, paid))
      .toBe("A restored barn.");
  });

  it("truncates on an excerpt tier, on a word boundary, with an ellipsis", () => {
    const out = displayedDescription(
      { description: "A restored barn with a lake and a long driveway.", shortDescription: null },
      free,
    );
    expect(out).toBe("A restored barn…");
  });

  it("leaves a short description alone even on an excerpt tier", () => {
    expect(displayedDescription({ description: "Short.", shortDescription: null }, free)).toBe("Short.");
  });

  it("falls back to the short description when there is no long one", () => {
    expect(displayedDescription({ description: null, shortDescription: "Brief." }, paid)).toBe("Brief.");
  });

  it("returns null when there is nothing to show, so nothing is asserted", () => {
    expect(displayedDescription({ description: null, shortDescription: null }, paid)).toBeNull();
  });
});

describe("displayedSocials", () => {
  it("returns the socials only on a tier that renders them", () => {
    expect(displayedSocials(["https://a.test"], paid)).toEqual(["https://a.test"]);
    expect(displayedSocials(["https://a.test"], free)).toEqual([]);
  });

  it("returns an empty list for a malformed socials column", () => {
    expect(displayedSocials(null, paid)).toEqual([]);
    expect(displayedSocials({ x: 1 }, paid)).toEqual([]);
  });

  it("drops non-string entries rather than putting them in sameAs", () => {
    expect(displayedSocials(["https://a.test", 7, null], paid)).toEqual(["https://a.test"]);
  });
});
