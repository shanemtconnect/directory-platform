import { describe, it, expect } from "vitest";
import { themeStyleVars } from "./theme";

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
      "--font-heading": '"Fraunces"',
      "--font-body": '"Inter"',
      "--radius": "0.75rem",
    });
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
    expect(() => themeStyleVars({ ...theme, fontBody: 'Inter";color:red' })).toThrow(/unsafe/i);
  });

  it("names the offending token so a clone typo is findable", () => {
    expect(() => themeStyleVars({ ...theme, radius: "1rem;}" })).toThrow(/--radius/);
  });
});
