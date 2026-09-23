import { describe, it, expect } from "vitest";
import { parseSegment, describeSegment } from "./segment";

describe("parseSegment", () => {
  it("reads a city segment", () => {
    expect(parseSegment(["city=leeds"])).toEqual({ city: "leeds" });
  });

  it("slugifies the value, so a human can type a real place name", () => {
    expect(parseSegment(["city=Stoke on Trent"])).toEqual({ city: "stoke-on-trent" });
  });

  it("reads a category segment, and both together", () => {
    expect(parseSegment(["category=barn-venues"])).toEqual({ category: "barn-venues" });
    expect(parseSegment(["city=leeds", "category=barn-venues"])).toEqual({
      city: "leeds",
      category: "barn-venues",
    });
  });

  it("accepts one comma-separated string as well as repeated flags", () => {
    expect(parseSegment(["city=leeds,category=barn-venues"])).toEqual({
      city: "leeds",
      category: "barn-venues",
    });
  });

  it("returns an empty segment for no input — the whole unclaimed set", () => {
    expect(parseSegment([])).toEqual({});
    expect(parseSegment(undefined)).toEqual({});
  });

  it("refuses a key it does not know rather than silently ignoring it", () => {
    // Silently dropping `--segment ciyt=leeds` would email the entire country.
    expect(() => parseSegment(["ciyt=leeds"])).toThrow(/unknown segment/i);
    expect(() => parseSegment(["leeds"])).toThrow(/key=value/i);
  });

  it("refuses an empty value", () => {
    expect(() => parseSegment(["city="])).toThrow(/empty/i);
  });
});

describe("describeSegment", () => {
  it("names the segment for the campaign row", () => {
    expect(describeSegment({ city: "leeds", category: "barn-venues" })).toBe(
      "city=leeds category=barn-venues",
    );
    expect(describeSegment({})).toBe("all unclaimed");
  });
});
