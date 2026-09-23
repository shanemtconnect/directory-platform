import type { ReactNode } from "react";

/**
 * The one horizontal measure on the site.
 *
 * `main` gets the same width from a rule in globals.css, because every route
 * renders its own `<main>` and wrapping twenty-five of them by hand would be
 * twenty-five chances to disagree. This component is for the full-bleed bands
 * that sit outside it — the header and the footer — whose background runs edge
 * to edge while their contents have to line up with the page above and below.
 */
export function Container({
  children,
  className = "",
  as: Tag = "div",
}: {
  children: ReactNode;
  className?: string;
  as?: "div" | "section" | "nav";
}) {
  return (
    <Tag className={`mx-auto w-full max-w-6xl px-4 sm:px-6 lg:px-8 ${className}`.trim()}>
      {children}
    </Tag>
  );
}
