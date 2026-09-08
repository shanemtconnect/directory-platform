import { describe, it, expect } from "vitest";
import {
  BADGE_STYLES,
  badgeDimensions,
  escapeXml,
  parseBadgeStyle,
  renderBadgeSvg,
  truncate,
  type BadgeStyle,
} from "./svg";

const HOSTILE = `Bob's <script>alert(1)</script> Bar & "Grill"`;

describe("escapeXml", () => {
  it("escapes all five entities", () => {
    expect(escapeXml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });

  it("escapes the ampersand first so entities are not doubled", () => {
    expect(escapeXml("a<b")).toBe("a&lt;b");
    expect(escapeXml("&lt;")).toBe("&amp;lt;");
  });
});

describe("renderBadgeSvg name escaping", () => {
  for (const style of BADGE_STYLES) {
    it(`neutralises script tags and ampersands in the ${style} badge`, () => {
      const svg = renderBadgeSvg({
        siteName: "Which & Where",
        listingName: HOSTILE,
        style,
        verified: true,
        ratingAvg: "4.7",
        ratingCount: 12,
      });

      // No injected element survives.
      expect(svg).not.toContain("<script");
      expect(svg).not.toContain("</script>");
      expect(svg.toLowerCase()).not.toContain("alert(1)</");

      // The dangerous characters only ever appear as entities.
      const inner = svg.slice(svg.indexOf("<title>"));
      expect(inner).toContain("&lt;script&gt;");
      expect(inner).toContain("&amp;");
      expect(inner).not.toMatch(/&(?!amp;|lt;|gt;|quot;|#39;)/);

      // A raw quote inside an attribute would break the aria-label.
      const ariaLabel = /aria-label="([^"]*)"/.exec(svg)?.[1] ?? "";
      expect(ariaLabel).not.toContain("<");
      expect(ariaLabel).toContain("&#39;");
    });
  }

  it("produces a well-formed document that a strict XML parser accepts", () => {
    const svg = renderBadgeSvg({
      siteName: "Which & Where",
      listingName: HOSTILE,
      style: "dark",
      verified: false,
    });
    expect(svg.startsWith("<svg ")).toBe(true);
    expect(svg.endsWith("</svg>")).toBe(true);
    // Every < opens a tag we emitted; nothing from user input remains.
    const allowed = new Set(["svg", "title", "rect", "text", "circle", "path"]);
    const tagNames = [...svg.matchAll(/<\/?([a-zA-Z]+)/g)].map((m) => m[1] ?? "");
    for (const t of tagNames) expect(allowed.has(t)).toBe(true);
    expect(tagNames).not.toContain("script");
  });

  it("strips control characters that are illegal in XML", () => {
    const svg = renderBadgeSvg({
      siteName: "Site",
      listingName: "Bad\u0007Na\u0000me",
      style: "compact",
      verified: false,
    });
    expect(svg).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/);
    expect(svg).toContain("BadName");
  });
});

describe("verified state", () => {
  const base = { siteName: "Site", listingName: "The Old Mill", ratingCount: 3, ratingAvg: "4.5" };

  it("shows VERIFIED only when verified is true", () => {
    expect(renderBadgeSvg({ ...base, style: "dark", verified: true })).toContain("VERIFIED");
    expect(renderBadgeSvg({ ...base, style: "dark", verified: false })).not.toContain("VERIFIED");
  });

  it("omits the tick mark on every style when not verified", () => {
    for (const style of BADGE_STYLES) {
      const off = renderBadgeSvg({ ...base, style, verified: false });
      const on = renderBadgeSvg({ ...base, style, verified: true });
      expect(off).not.toContain("<circle");
      expect(on).toContain("<circle");
    }
  });
});

describe("rating style", () => {
  it("renders the average and count when there are ratings", () => {
    const svg = renderBadgeSvg({
      siteName: "Site",
      listingName: "The Old Mill",
      style: "rating",
      verified: false,
      ratingAvg: "4.62",
      ratingCount: 41,
    });
    expect(svg).toContain("4.6 (41)");
  });

  it("says so plainly when there are none", () => {
    const svg = renderBadgeSvg({
      siteName: "Site",
      listingName: "The Old Mill",
      style: "rating",
      verified: false,
      ratingAvg: null,
      ratingCount: 0,
    });
    expect(svg).toContain("No ratings yet");
  });
});

describe("parseBadgeStyle", () => {
  it("accepts the four styles", () => {
    for (const s of BADGE_STYLES) expect(parseBadgeStyle(s)).toBe(s);
  });
  it("falls back to dark for anything else", () => {
    for (const bad of [null, undefined, "", "DARK ", "neon", "../../etc/passwd"]) {
      const result = parseBadgeStyle(bad as string | null);
      expect(BADGE_STYLES).toContain(result);
    }
    expect(parseBadgeStyle("neon")).toBe("dark");
    expect(parseBadgeStyle("LIGHT")).toBe("light");
  });
});

describe("dimensions", () => {
  it("gives every style a positive width and height", () => {
    for (const s of BADGE_STYLES as readonly BadgeStyle[]) {
      const d = badgeDimensions(s);
      expect(d.width).toBeGreaterThan(0);
      expect(d.height).toBeGreaterThan(0);
    }
  });

  it("matches the declared viewBox", () => {
    for (const s of BADGE_STYLES) {
      const { width, height } = badgeDimensions(s);
      const svg = renderBadgeSvg({ siteName: "S", listingName: "N", style: s, verified: false });
      expect(svg).toContain(`viewBox="0 0 ${width} ${height}"`);
      expect(svg).toContain(`width="${width}"`);
    }
  });
});

describe("truncate", () => {
  it("leaves short strings alone", () => {
    expect(truncate("short", 20)).toBe("short");
  });
  it("ellipsises long ones without exceeding the cap", () => {
    const out = truncate("a".repeat(50), 10);
    expect(out.length).toBeLessThanOrEqual(10);
    expect(out.endsWith("…")).toBe(true);
  });
});
