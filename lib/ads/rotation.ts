import { createHash } from "node:crypto";

/**
 * Deterministic, weighted rotation. Seeded by build id + day so an ISR window
 * always renders the same cards (no client JS, no layout shift between the
 * cached HTML and anything else) and a fresh build or a new day reshuffles.
 *
 * Weighted sampling without replacement (Efraimidis–Spirakis): each campaign
 * gets `u ^ (1/weight)` for a uniform `u` derived from `hash(seed, id)`, and
 * the highest keys win. A weight of 2 is picked first roughly twice as often
 * as a weight of 1, and no campaign is ever shown twice on one page.
 */
export interface Rotatable {
  readonly id: string;
  readonly weight: number;
}

export function rotationSeed(buildId: string, day: string): string {
  return `${buildId}\n${day}`;
}

/** A uniform in (0, 1) from the first 52 bits of sha256(seed, id). */
function uniform(seed: string, id: string): number {
  const digest = createHash("sha256").update(`${seed}\n${id}`).digest();
  // 52 bits so the value is exact in a double; +1 keeps it off zero.
  const hi = digest.readUInt32BE(0) >>> 0;
  const lo = digest.readUInt32BE(4) >>> 12;
  const n = hi * 2 ** 20 + lo;
  return (n + 1) / (2 ** 52 + 2);
}

export function rotate<T extends Rotatable>(items: readonly T[], seed: string, limit: number): T[] {
  if (limit <= 0 || items.length === 0) return [];
  const keyed = items.map((item) => {
    const weight = Number.isFinite(item.weight) && item.weight >= 1 ? item.weight : 1;
    return { item, key: uniform(seed, item.id) ** (1 / weight) };
  });
  keyed.sort((a, b) => b.key - a.key || (a.item.id < b.item.id ? -1 : 1));
  return keyed.slice(0, limit).map((k) => k.item);
}
