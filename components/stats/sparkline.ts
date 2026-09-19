/**
 * The sparkline's geometry, as an inline `<polyline>` and nothing else.
 *
 * No charting library. A chart library for one 60-point line would be more
 * JavaScript than the rest of the page put together, and it would have to be a
 * client component — on a page whose whole point is a table of numbers the
 * server already has.
 *
 * Separated from the component so the arithmetic can be tested, because the
 * failure mode of a hand-rolled chart is a line that silently leaves the
 * viewBox and is simply invisible.
 */

export const SPARKLINE_BOX = { width: 600, height: 80, padding: 6 } as const;

export interface Sparkline {
  /** `x,y x,y …` for a `<polyline points>`. */
  points: string;
  /** The largest value in the series, for the label beside the line. */
  max: number;
}

/** One decimal is under a tenth of a pixel at this size, and halves the markup. */
function round(n: number): number {
  return Math.round(n * 10) / 10;
}

export function sparkline(
  values: number[],
  box: { width: number; height: number; padding: number } = SPARKLINE_BOX,
): Sparkline | null {
  if (values.length === 0) return null;

  // A NaN anywhere in a points list makes the whole polyline vanish, so the
  // series is cleaned before anything is measured against it.
  const clean = values.map((v) => (Number.isFinite(v) && v > 0 ? v : 0));
  const max = Math.max(...clean);

  const top = box.padding;
  const bottom = box.height - box.padding;
  const left = box.padding;
  const right = box.width - box.padding;
  const span = clean.length > 1 ? (right - left) / (clean.length - 1) : 0;

  const points = clean.map((v, i) => {
    // A single day has nowhere to travel; centring it beats a dot in the
    // corner, and avoids dividing by a zero-length span.
    const x = clean.length > 1 ? left + i * span : box.width / 2;
    // An all-zero series is a flat line on the baseline, not a division by
    // zero and not a line at the top implying a full bar.
    const y = max === 0 ? bottom : bottom - (v / max) * (bottom - top);
    return `${round(x)},${round(y)}`;
  });

  return { points: points.join(" "), max };
}
