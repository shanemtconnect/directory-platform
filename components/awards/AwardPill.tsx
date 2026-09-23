/**
 * The "Winner <year>" pill (Task 50).
 *
 * Rendered only from a row in the `awards` table — the caller read it there,
 * this only prints it. The word is the badge, as on the Verified pill: it has
 * to survive a monochrome screenshot and a screen reader.
 */
export function AwardPill({ year, href }: { year: number; href?: string }) {
  const label = `Winner ${year}`;
  const className = "pill pill-on";
  if (href === undefined) {
    return <span data-testid="award-pill" data-year={year} className={className}>{label}</span>;
  }
  return (
    <a data-testid="award-pill" data-year={year} className={`${className} no-underline`} href={href}>
      {label}
    </a>
  );
}
