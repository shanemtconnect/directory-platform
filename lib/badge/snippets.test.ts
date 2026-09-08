import { describe, it, expect } from "vitest";
import { siteConfig } from "@/config/site.config";
import {
  anchorVariants,
  badgeImageUrl,
  badgeKit,
  badgeSnippetHtml,
  badgeTargetUrl,
  escapeHtml,
  UTM,
  type SnippetInput,
} from "./snippets";
import { BADGE_STYLES, badgeDimensions } from "./svg";

const HOSTILE: SnippetInput = {
  listingId: "3f2b0c9e-1111-4222-8333-444455556666",
  listingName: `Bob's <script>alert(1)</script> Bar & "Grill"`,
  listingPath: "/bath/bobs-bar",
  cityName: `St <b>Ives</b> & District`,
  categoryName: `Barn & "Loft"`,
  style: "dark",
};

const CLEAN: SnippetInput = {
  ...HOSTILE,
  listingName: "The Old Mill",
  cityName: "Bath",
  categoryName: "Barn",
};

describe("badgeImageUrl", () => {
  it("is /badge/{id}?style={style} on the site origin", () => {
    const url = badgeImageUrl(CLEAN.listingId, "compact");
    expect(url).toContain(`/badge/${CLEAN.listingId}?style=compact`);
    expect(url.startsWith("http")).toBe(true);
  });

  it("url-encodes the id so a crafted id cannot add query parameters", () => {
    const url = badgeImageUrl("abc?x=1&y=2", "dark");
    expect(url).toContain("abc%3Fx%3D1%26y%3D2");
    expect(url.split("?").length).toBe(2);
  });
});

describe("badgeTargetUrl", () => {
  it("tags the link for attribution", () => {
    expect(badgeTargetUrl("/bath/bobs-bar")).toContain(`?${UTM}`);
    expect(UTM).toBe("utm_source=badge&utm_medium=referral");
  });
  it("tolerates a path without a leading slash", () => {
    expect(badgeTargetUrl("bath/bobs-bar")).toContain("/bath/bobs-bar?");
  });
});

describe("badgeSnippetHtml", () => {
  it("wraps an img in an a, with dimensions, lazy loading and a real alt", () => {
    const html = badgeSnippetHtml(CLEAN);
    const { width, height } = badgeDimensions("dark");
    expect(html).toMatch(/^<a href="/);
    expect(html).toContain("<img src=");
    expect(html).toContain(`width="${width}" height="${height}"`);
    expect(html).toContain('loading="lazy"');
    expect(html).toContain(`alt="The Old Mill is listed on ${siteConfig.name}`);
    expect(html).toContain("utm_source=badge&amp;utm_medium=referral");
    expect(html.trimEnd().endsWith("</a>")).toBe(true);
  });

  it("escapes a hostile listing name everywhere it appears", () => {
    const html = badgeSnippetHtml(HOSTILE);
    expect(html).not.toContain("<script");
    expect(html).not.toContain("</script>");
    // The quote in Bob's would otherwise close alt="" and title="".
    const attrs = [...html.matchAll(/(?:alt|title)="([^"]*)"/g)].map((m) => m[1] ?? "");
    expect(attrs.length).toBeGreaterThan(0);
    for (const a of attrs) {
      expect(a).not.toContain("<");
      expect(a).not.toContain(">");
    }
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&#39;");
    expect(html).toContain("&quot;");
  });

  it("emits exactly one anchor and one image", () => {
    const html = badgeSnippetHtml(HOSTILE);
    expect((html.match(/<a /g) ?? []).length).toBe(1);
    expect((html.match(/<img /g) ?? []).length).toBe(1);
  });
});

describe("anchorVariants", () => {
  it("offers three distinct branded variants", () => {
    const v = anchorVariants(CLEAN);
    expect(v).toHaveLength(3);
    expect(new Set(v.map((x) => x.text)).size).toBe(3);
    expect(v.map((x) => x.key)).toEqual(["brand", "descriptive", "verified"]);
  });

  it("builds them from siteConfig, never from a hardcoded noun", () => {
    const v = anchorVariants(CLEAN);
    expect(v[0]?.text).toBe(siteConfig.name);
    expect(v[1]?.text).toBe(`Barn in Bath on ${siteConfig.name}`);
    expect(v[2]?.text).toBe(
      `${siteConfig.name} verified ${siteConfig.entity.Singular.toLowerCase()}`,
    );
  });

  it("escapes hostile city and category names in both href and text", () => {
    for (const v of anchorVariants(HOSTILE)) {
      expect(v.html).not.toContain("<b>");
      expect(v.html).not.toContain("</b>");
      const inner = v.html.slice(v.html.indexOf(">") + 1, v.html.lastIndexOf("</a>"));
      expect(inner).not.toContain("<");
      expect(inner).not.toContain(">");
    }
    expect(anchorVariants(HOSTILE)[1]?.html).toContain("&lt;b&gt;");
  });

  it("always points at the tagged listing URL", () => {
    for (const v of anchorVariants(CLEAN)) {
      expect(v.html).toContain("utm_source=badge&amp;utm_medium=referral");
    }
  });
});

describe("escapeHtml", () => {
  it("covers the same five characters as the SVG escape", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });
});

describe("badgeKit", () => {
  it("produces a complete kit for every style", () => {
    for (const style of BADGE_STYLES) {
      const kit = badgeKit({ ...CLEAN, style });
      expect(kit.style).toBe(style);
      expect(kit.imageUrl).toContain(`style=${style}`);
      expect(kit.embed).toContain(`width="${kit.dimensions.width}"`);
      expect(kit.anchors).toHaveLength(3);
      expect(kit.targetUrl).toContain(UTM);
    }
  });
});
