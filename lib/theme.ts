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

/**
 * Theme tokens as CSS custom properties for React's `style` prop.
 *
 * Returns an object, not a string: React's style object has no `cssText` escape
 * hatch, and passing one renders a bogus `css-text` declaration that applies
 * nothing at all.
 */
export function themeStyleVars(theme: SiteConfig["theme"]): ThemeStyle {
  return {
    "--color-primary": safe("--color-primary", theme.primary),
    "--color-accent": safe("--color-accent", theme.accent),
    "--font-heading": `"${safe("--font-heading", theme.fontHeading)}"`,
    "--font-body": `"${safe("--font-body", theme.fontBody)}"`,
    "--radius": safe("--radius", theme.radius),
  };
}
