import { slugify } from "@/lib/routing/slugify";

/**
 * `--segment city=leeds --segment category=<category-slug>`
 *
 * Kept to slugs the routing layer already uses, and to keys that exist: a
 * typo'd key that parsed to "no filter" would turn a fifty-listing batch into
 * the entire unclaimed database. Unknown keys are an error, loudly.
 */
export interface Segment {
  city?: string;
  category?: string;
}

const KEYS = new Set(["city", "category"]);

export function parseSegment(input: readonly string[] | undefined): Segment {
  const segment: Segment = {};
  for (const raw of (input ?? []).flatMap((s) => s.split(","))) {
    const entry = raw.trim();
    if (entry === "") continue;
    const at = entry.indexOf("=");
    if (at === -1) throw new Error(`Segment must be key=value, got "${entry}"`);
    const key = entry.slice(0, at).trim().toLowerCase();
    const value = slugify(entry.slice(at + 1).trim());
    if (!KEYS.has(key)) {
      throw new Error(`Unknown segment key "${key}" — expected one of ${[...KEYS].join(", ")}`);
    }
    if (value === "") throw new Error(`Segment "${key}" has an empty value`);
    if (key === "city") segment.city = value;
    else segment.category = value;
  }
  return segment;
}

/** Human-readable, for the campaign name and the log line. */
export function describeSegment(segment: Segment): string {
  const parts: string[] = [];
  if (segment.city !== undefined) parts.push(`city=${segment.city}`);
  if (segment.category !== undefined) parts.push(`category=${segment.category}`);
  return parts.length === 0 ? "all unclaimed" : parts.join(" ");
}
