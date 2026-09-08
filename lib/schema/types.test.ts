import { describe, it, expect } from "vitest";
import { prune } from "./types";

describe("prune", () => {
  it("drops undefined, null and empty strings", () => {
    expect(prune({ a: "x", b: undefined, c: "", d: null as never })).toEqual({ a: "x" });
  });

  it("keeps zero and false, which are real values", () => {
    expect(prune({ lat: 0, verified: false })).toEqual({ lat: 0, verified: false });
  });

  it("drops empty arrays", () => {
    expect(prune({ image: [], name: "x" })).toEqual({ name: "x" });
  });

  it("drops a nested node that has only an @type", () => {
    expect(prune({ name: "x", geo: { "@type": "GeoCoordinates", latitude: undefined } }))
      .toEqual({ name: "x" });
  });

  it("keeps a nested node that has real data", () => {
    expect(prune({ geo: { "@type": "GeoCoordinates", latitude: 1, longitude: 2, alt: undefined } }))
      .toEqual({ geo: { "@type": "GeoCoordinates", latitude: 1, longitude: 2 } });
  });

  it("prunes inside arrays and drops the ones left empty", () => {
    expect(prune({ items: [{ "@type": "X", url: "u" }, { "@type": "X", url: undefined }] }))
      .toEqual({ items: [{ "@type": "X", url: "u" }] });
  });

  it("removes a key whose array becomes empty after pruning", () => {
    expect(prune({ items: [{ "@type": "X" }], name: "keep" })).toEqual({ name: "keep" });
  });
});

describe("serialiseJsonLd", () => {
  it("escapes < so listing content cannot close the script tag", async () => {
    const { serialiseJsonLd } = await import("./types");
    const out = serialiseJsonLd({ name: "Bad </script><script>alert(1)</script>" });
    expect(out).not.toContain("</script>");
    expect(out).toContain("\\u003c");
  });

  it("prunes before serialising", async () => {
    const { serialiseJsonLd } = await import("./types");
    expect(serialiseJsonLd({ a: "x", b: undefined })).toBe('{"a":"x"}');
  });
});
