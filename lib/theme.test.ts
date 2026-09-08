import { describe, it, expect } from "vitest";
import { readableOn, themeStyleVars } from "./theme";
import type { FontFamily } from "@/config/types";

const theme = {
  primary: "#8B5A3C",
  accent: "#D4AF37",
  fontHeading: "Fraunces",
  fontBody: "Inter",
  radius: "0.75rem",
} as const;

describe("themeStyleVars", () => {
  it("emits every token as a CSS custom property key", () => {
    expect(themeStyleVars(theme)).toEqual({
      "--color-primary": "#8B5A3C",
      "--color-accent": "#D4AF37",
      "--color-on-primary": "#ffffff",
      "--color-on-accent": "#000000",
      "--font-heading": '"Fraunces"',
      "--font-body": '"Inter"',
      "--radius": "0.75rem",
    });
  });

  it("emits a readable foreground for each theme colour, so a clone cannot ship white on gold", () => {
    const vars = themeStyleVars({ ...theme, primary: "#D4AF37", accent: "#8B5A3C" });
    expect(vars["--color-on-primary"]).toBe("#000000");
    expect(vars["--color-on-accent"]).toBe("#ffffff");
  });

  it("quotes font family names so multi-word fonts survive", () => {
    expect(themeStyleVars({ ...theme, fontHeading: "Playfair Display" })["--font-heading"])
      .toBe('"Playfair Display"');
  });

  it("returns keys React will emit as custom properties, not camelCase", () => {
    for (const key of Object.keys(themeStyleVars(theme))) {
      expect(key.startsWith("--")).toBe(true);
    }
  });

  it("rejects a value containing a semicolon or brace", () => {
    expect(() => themeStyleVars({ ...theme, primary: "red;}body{display:none" })).toThrow(/unsafe/i);
  });

  it("rejects a value containing angle brackets", () => {
    expect(() => themeStyleVars({ ...theme, accent: "<script>" })).toThrow(/unsafe/i);
  });

  it("rejects a quote that would break out of the font declaration", () => {
    // Cast on purpose. `fontBody` is typed as the FontFamily union now, but
    // site.config.ts is hand-edited on every clone and a hand edit can put any
    // string there — the runtime guard is what actually holds, and it has to
    // keep holding when the type is bypassed.
    const injected = 'Inter";color:red' as FontFamily;
    expect(() => themeStyleVars({ ...theme, fontBody: injected })).toThrow(/unsafe/i);
  });

  it("names the offending token so a clone typo is findable", () => {
    expect(() => themeStyleVars({ ...theme, radius: "1rem;}" })).toThrow(/--radius/);
  });
});

describe("readableOn", () => {
  it("puts white text on the default primary, which is dark enough for it", () => {
    expect(readableOn("#8B5A3C")).toBe("#ffffff");
  });

  it("puts black text on the default accent, which is a light gold", () => {
    expect(readableOn("#D4AF37")).toBe("#000000");
  });

  it("picks white on black and black on white", () => {
    expect(readableOn("#000000")).toBe("#ffffff");
    expect(readableOn("#ffffff")).toBe("#000000");
  });

  it("is case-insensitive and accepts the three-digit shorthand", () => {
    expect(readableOn("#fff")).toBe(readableOn("#FFFFFF"));
    expect(readableOn("#8b5a3c")).toBe(readableOn("#8B5A3C"));
  });

  it("weights green the way the eye does, not by naive average", () => {
    // #0000FF and #00FF00 have the same naive mean but nothing like the same
    // luminance, so a mean-based implementation gets one of these wrong.
    expect(readableOn("#0000ff")).toBe("#ffffff");
    expect(readableOn("#00ff00")).toBe("#000000");
  });

  it("always returns the choice with the better contrast ratio", () => {
    for (const hex of ["#8B5A3C", "#D4AF37", "#767676", "#777777", "#1c1917", "#faf9f7"]) {
      const chosen = readableOn(hex);
      expect(contrast(hex, chosen)).toBeGreaterThanOrEqual(
        contrast(hex, chosen === "#ffffff" ? "#000000" : "#ffffff"),
      );
    }
  });

  it("never returns a pair below the 4.5:1 body-text threshold on a theme colour", () => {
    for (const hex of [theme.primary, theme.accent]) {
      expect(contrast(hex, readableOn(hex))).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("rejects anything that is not a hex colour, naming the value", () => {
    expect(() => readableOn("rebeccapurple")).toThrow(/rebeccapurple/);
    expect(() => readableOn("#12345")).toThrow(/hex/i);
    expect(() => readableOn("#GGGGGG")).toThrow(/hex/i);
  });
});

/** WCAG 2.x contrast ratio, written independently of the implementation. */
function contrast(a: string, b: string): number {
  const lum = (hex: string): number => {
    const full = hex.length === 4
      ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`
      : hex;
    const channels = [1, 3, 5].map((i) => parseInt(full.slice(i, i + 2), 16) / 255);
    const [r, g, bl] = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}
