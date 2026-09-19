import {
  DM_Sans,
  Fraunces,
  Inter,
  Lora,
  Playfair_Display,
  Source_Sans_3,
} from "next/font/google";

/**
 * TODO(merge): import from config/types.
 *
 * Task 10 is adding this union to config/types.ts in the same cycle. It is
 * declared locally so this file compiles on its own branch; the two are
 * reconciled on merge and this alias goes away.
 */
export type FontFamily =
  | "Fraunces"
  | "Inter"
  | "Playfair Display"
  | "Source Sans 3"
  | "DM Sans"
  | "Lora";

/**
 * next/font is a build-time transform, not a function call: every argument has
 * to be a literal, so the family cannot be looked up from site.config.ts at
 * runtime. Hence a map — every family the config is allowed to name is loaded
 * here, and the config picks two of them.
 *
 * `preload: false` on all of them because that is the honest trade. The
 * transform emits an @font-face block per entry into the shared stylesheet
 * whether or not the clone uses it (unused faces are never fetched — a browser
 * only downloads a face something matches), but a preload link IS a fetch, and
 * preloading six families to use two would cost more than swap ever does.
 */
/*
 * One `const` per loader at module scope, and the options written out at each
 * call site. Both are requirements of the transform, not style: it rejects a
 * hoisted options object and it rejects a loader called anywhere but here.
 */
const fraunces = Fraunces({ subsets: ["latin"], display: "swap", preload: false });
const inter = Inter({ subsets: ["latin"], display: "swap", preload: false });
const playfairDisplay = Playfair_Display({ subsets: ["latin"], display: "swap", preload: false });
const sourceSans3 = Source_Sans_3({ subsets: ["latin"], display: "swap", preload: false });
const dmSans = DM_Sans({ subsets: ["latin"], display: "swap", preload: false });
const lora = Lora({ subsets: ["latin"], display: "swap", preload: false });

const FONTS: Readonly<Record<FontFamily, { style: { fontFamily: string } }>> = {
  Fraunces: fraunces,
  Inter: inter,
  "Playfair Display": playfairDisplay,
  "Source Sans 3": sourceSans3,
  "DM Sans": dmSans,
  Lora: lora,
};

/**
 * The system stacks a family falls back to. Kept even when the webfont loads:
 * `display: swap` means the fallback is what renders first, and on a heading
 * that is most of the visible page load.
 */
const SERIF_FALLBACK = "Georgia, 'Times New Roman', serif";
const SANS_FALLBACK = "system-ui, -apple-system, 'Segoe UI', sans-serif";

const isKnown = (name: string): name is FontFamily => name in FONTS;

/**
 * The `font-family` value for a configured family name.
 *
 * next/font's own `style.fontFamily` already carries its size-adjusted local
 * fallback, which is what stops the swap from reflowing the page; the system
 * stack goes on the end of it rather than in place of it.
 *
 * A name the map does not know is not an error — a clone may be self-hosting —
 * so it falls through to the stack alone and the family keeps whatever
 * `themeStyleVars` quoted for it.
 */
export function fontFamilyFor(name: string, role: "heading" | "body"): string | null {
  const fallback = role === "heading" ? SERIF_FALLBACK : SANS_FALLBACK;
  if (!isKnown(name)) return null;
  return `${FONTS[name].style.fontFamily}, ${fallback}`;
}

/**
 * The font half of the `<html>` style object. Merged over `themeStyleVars`, so
 * an unknown family simply leaves that function's quoted name in place.
 */
export function fontStyleVars(theme: {
  readonly fontHeading: string;
  readonly fontBody: string;
}): Record<`--${string}`, string> {
  const heading = fontFamilyFor(theme.fontHeading, "heading");
  const body = fontFamilyFor(theme.fontBody, "body");
  return {
    ...(heading ? { "--font-heading": heading } : {}),
    ...(body ? { "--font-body": body } : {}),
  };
}
