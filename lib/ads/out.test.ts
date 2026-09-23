import { describe, expect, it } from "vitest";
import { MAX_TARGET_URL_LENGTH, cleanTargetUrl, isSafeTargetUrl } from "./out";

describe("isSafeTargetUrl", () => {
  it("accepts absolute http(s) URLs", () => {
    expect(isSafeTargetUrl("https://acme.example/landing")).toBe(true);
    expect(isSafeTargetUrl("http://acme.example")).toBe(true);
  });

  it.each([
    ["javascript:alert(1)", "a script URL"],
    ["ftp://acme.example/file", "another scheme"],
    ["/relative/path", "a relative path"],
    ["acme.example", "a bare hostname"],
    ["https://user:pw@acme.example/", "credentials"],
    ["https://localhost/x", "localhost"],
    ["", "an empty string"],
    [`https://acme.example/${"a".repeat(MAX_TARGET_URL_LENGTH)}`, "an absurd length"],
  ])("refuses %s (%s)", (value) => {
    expect(isSafeTargetUrl(value)).toBe(false);
  });
});

describe("cleanTargetUrl", () => {
  it("keeps utm_* and the path, fragment and unknown params", () => {
    const url = "https://acme.example/l?utm_source=dir&utm_campaign=sept&page=2#top";
    expect(cleanTargetUrl(url)).toBe(url);
  });

  it("strips click ids that belong to other platforms", () => {
    expect(
      cleanTargetUrl("https://acme.example/l?fbclid=abc&utm_source=dir&gclid=1&mc_eid=x&oly_enc_id=9"),
    ).toBe("https://acme.example/l?utm_source=dir");
  });

  it("drops the query entirely when nothing is left", () => {
    expect(cleanTargetUrl("https://acme.example/l?fbclid=abc")).toBe("https://acme.example/l");
  });

  it("is case-insensitive about the parameter name", () => {
    expect(cleanTargetUrl("https://acme.example/?FBCLID=1&Page=3")).toBe("https://acme.example/?Page=3");
  });

  it("returns null for anything unsafe rather than a cleaned-up version of it", () => {
    expect(cleanTargetUrl("javascript:alert(1)")).toBeNull();
    expect(cleanTargetUrl("https://user:pw@acme.example/")).toBeNull();
  });
});
