import type { CSSProperties } from "react";
import type { SiteConfig } from "@/config/types";

/**
 * React's CSSProperties has no index signature for custom properties, so a
 * `--token` key is a type error against it even though React renders it fine.
 */
export type ThemeStyle = CSSProperties & Record<`--${string}`, string>;

// site.config.ts is hand-edited on every clone. Anything that could terminate a
// declaration or open a tag is rejected loudly rather than silently breaking the page.
const UNSAFE = /[;{}<>"']/;

function safe(token: string, value: string): string {
  if (UNSAFE.test(value)) {
    throw new Error(`Unsafe value for theme token "${token}": ${JSON.stringify(value)}`);
  }
  return value;
}

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** WCAG relative luminance of a #rgb or #rrggbb colour. */
function luminance(hex: string): number {
  const full =
    hex.length === 4
      ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`
      : hex;
  const linear = [1, 3, 5].map((i) => {
    const c = parseInt(full.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

/**
 * Black or white — whichever a clone's theme colour can actually be read
 * against.
 *
 * The default theme is a dark brown and a light gold, so a hardcoded
 * `text-white` on both would leave every accent button at 2.1:1. The choice is
 * made from the colour rather than assumed, because the colour is edited per
 * clone and nobody re-checks the contrast afterwards.
 *
 * Green is weighted seven times blue here, as the eye weights it. A naive
 * average of the channels gets #0000ff and #00ff00 — identical means, wildly
 * different luminance — exactly backwards.
 */
export function readableOn(hex: string): "#000000" | "#ffffff" {
  if (!HEX.test(hex)) {
    throw new Error(`Not a hex colour: ${JSON.stringify(hex)} (expected #rgb or #rrggbb)`);
  }
  const l = luminance(hex);
  // Contrast against white is 1.05/(L+0.05); against black it is (L+0.05)/0.05.
  // They cross at L = sqrt(1.05 * 0.05) - 0.05.
  return 1.05 / (l + 0.05) >= (l + 0.05) / 0.05 ? "#ffffff" : "#000000";
}

/**
 * Theme tokens as CSS custom properties for React's `style` prop.
 *
 * Returns an object, not a string: React's style object has no `cssText` escape
 * hatch, and passing one renders a bogus `css-text` declaration that applies
 * nothing at all.
 *
 * `primary` and `accent` must be hex. That is a real constraint on a clone, and
 * a deliberate one: the readable foreground for each is derived here, and a
 * colour written as `oklch(...)` would have to be resolved by a browser before
 * anyone could say what text goes on top of it.
 */
export function themeStyleVars(theme: SiteConfig["theme"]): ThemeStyle {
  return {
    "--color-primary": safe("--color-primary", theme.primary),
    "--color-accent": safe("--color-accent", theme.accent),
    // Derived, never configured: a clone that picks its own brand colour gets a
    // legible foreground for it without having to think about contrast ratios.
    "--color-on-primary": readableOn(safe("--color-primary", theme.primary)),
    "--color-on-accent": readableOn(safe("--color-accent", theme.accent)),
    "--font-heading": `"${safe("--font-heading", theme.fontHeading)}"`,
    "--font-body": `"${safe("--font-body", theme.fontBody)}"`,
    "--radius": safe("--radius", theme.radius),
  };
}
