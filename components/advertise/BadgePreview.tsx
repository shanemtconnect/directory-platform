import { renderBadgeSvg, type BadgeInput } from "@/lib/badge/svg";

/**
 * Live preview, rendered inline rather than fetched from /badge/{id}, so the
 * page shows every style without four network round-trips and works before a
 * listing exists.
 *
 * dangerouslySetInnerHTML is safe here for exactly one reason: renderBadgeSvg
 * escapes every interpolated value. If that ever stops being true, this line
 * becomes a stored-XSS hole — see lib/badge/svg.test.ts.
 */
export function BadgePreview({ input }: { input: BadgeInput }) {
  const svg = renderBadgeSvg(input);
  return (
    <div
      role="img"
      aria-label={`${input.style} badge preview`}
      className="inline-block"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
