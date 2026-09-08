/** A JSON-LD node. Values are whatever schema.org allows. */
export type JsonLdValue = string | number | boolean | JsonLd | JsonLdValue[];
export interface JsonLd {
  [key: string]: JsonLdValue | undefined;
}

const isNode = (v: unknown): v is JsonLd =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** A node carrying nothing but its @type conveys no information. */
const isEmptyNode = (n: JsonLd): boolean =>
  Object.keys(n).filter((k) => k !== "@type").length === 0;

function pruneValue(value: JsonLdValue | undefined): JsonLdValue | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (Array.isArray(value)) {
    const items = value.map(pruneValue).filter((v): v is JsonLdValue => v !== undefined);
    return items.length > 0 ? items : undefined;
  }
  if (isNode(value)) {
    const nested = prune(value);
    return isEmptyNode(nested) ? undefined : nested;
  }
  return value;
}

/**
 * Drops every key whose value is undefined, null, an empty string, an empty
 * array, or a node with only an @type — recursively.
 *
 * The most common way a directory earns a manual action is emitting fields it
 * has no real data for. Building a node optimistically and pruning here is
 * safer than dozens of conditional spreads, because a missing value cannot
 * survive it. Zero and false are kept: they are real values.
 */
export function prune(node: JsonLd): JsonLd {
  const out: JsonLd = {};
  for (const [key, value] of Object.entries(node)) {
    const pruned = pruneValue(value);
    if (pruned !== undefined) out[key] = pruned;
  }
  return out;
}

/** Serialises for a <script type="application/ld+json">, escaping the one character that can break out. */
export function serialiseJsonLd(node: JsonLd): string {
  return JSON.stringify(prune(node)).replace(/</g, "\\u003c");
}
