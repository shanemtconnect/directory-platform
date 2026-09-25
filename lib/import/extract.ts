import { siteConfig } from "@/config/site.config";
import { DESCRIPTION_MAX as SUBMISSION_DESCRIPTION_MAX } from "@/lib/actions/validation";

/**
 * What a business's own web page says about it, in the add-listing form's
 * field names. Every field is optional: most pages carry some of this and
 * none carry all of it, and a field we could not read is left for the person
 * to type rather than guessed.
 */
export interface ImportedBusiness {
  name?: string;
  description?: string;
  /** Raw, as the page printed it. The submit action validates it. */
  phone?: string;
  /** Raw. The page's own URL claim, else the origin we fetched. */
  website?: string;
  addressLine1?: string;
  city?: string;
  region?: string;
  postcode?: string;
  /**
   * JSON-LD `sameAs` links. The form has no socials field today, so these are
   * returned and not prefilled — the field can use them the day it exists.
   */
  socials?: string[];
}

/**
 * The description cap. `listing.maxDescriptionChars` is the ceiling for any
 * listing, but the PUBLIC form accepts far less (see DESCRIPTION_MAX in
 * lib/actions/validation.ts), and prefilling more than it will accept is
 * handing the person a validation error they did not cause.
 */
export const IMPORT_DESCRIPTION_MAX = Math.min(
  siteConfig.listing.maxDescriptionChars,
  SUBMISSION_DESCRIPTION_MAX,
);

/*
 * No HTML parser. The page is a stranger's, so the scanner is built to be
 * tolerant rather than correct: it looks for three things — <meta>, <title>
 * and ld+json <script> — and never throws on markup it cannot make sense of.
 * Attribute values are matched quote-aware, so a `>` inside one does not end
 * the tag early.
 */
const ATTRS = `(?:[^>"']|"[^"]*"|'[^']*')*`;
const META = new RegExp(`<meta\\b(${ATTRS})>`, "gi");
const SCRIPT = new RegExp(`<script\\b(${ATTRS})>([\\s\\S]*?)</script\\s*>`, "gi");
const TITLE = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i;
const ATTR = /([^\s=/>]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

function attributes(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of raw.matchAll(ATTR)) {
    const name = m[1]!.toLowerCase();
    if (!out.has(name)) out.set(name, m[2] ?? m[3] ?? m[4] ?? "");
  }
  return out;
}

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—",
  rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", hellip: "…",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ref: string) => {
    if (ref[0] === "#") {
      const code = ref[1] === "x" || ref[1] === "X"
        ? Number.parseInt(ref.slice(2), 16)
        : Number.parseInt(ref.slice(1), 10);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED[ref.toLowerCase()] ?? whole;
  });
}

/** Entities decoded, tags dropped, whitespace collapsed. Empty becomes undefined. */
function clean(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const text = decodeEntities(String(value).replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
  return text === "" ? undefined : text;
}

function httpUrl(value: unknown, base: string): string | undefined {
  const text = clean(value);
  if (text === undefined) return undefined;
  try {
    const url = new URL(text, base);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function trimDescription(text: string | undefined): string | undefined {
  if (text === undefined || text.length <= IMPORT_DESCRIPTION_MAX) return text;
  let cut = text.slice(0, IMPORT_DESCRIPTION_MAX);
  // Back to the last word boundary, unless that throws away most of it.
  const space = cut.lastIndexOf(" ");
  if (text[IMPORT_DESCRIPTION_MAX] !== " " && space > IMPORT_DESCRIPTION_MAX * 0.8) cut = cut.slice(0, space);
  return cut.trimEnd();
}

/* ------------------------------------------------------------- JSON-LD */

type Node = Record<string, unknown>;

/** Types that are the business by name. Subtypes are recognised by shape. */
const BUSINESS_TYPES = new Set(["localbusiness", "organization", "corporation", "store"]);

/** Typed nodes that carry an address or phone but are never the business. */
const NOT_A_BUSINESS = new Set([
  "person", "postaladdress", "contactpoint", "website", "webpage", "breadcrumblist",
  "imageobject", "listitem", "offer", "review", "event", "place",
]);

function types(node: Node): string[] {
  const t = node["@type"];
  const list = Array.isArray(t) ? t : [t];
  return list.filter((x): x is string => typeof x === "string").map((x) => x.toLowerCase());
}

/** Every typed object in a JSON-LD document, however it is nested. */
function collect(value: unknown, into: Node[], depth = 0): void {
  if (depth > 8 || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collect(item, into, depth + 1);
    return;
  }
  const node = value as Node;
  if (types(node).length > 0) into.push(node);
  for (const child of Object.values(node)) collect(child, into, depth + 1);
}

function isBusiness(node: Node): boolean {
  const t = types(node);
  if (t.some((x) => NOT_A_BUSINESS.has(x))) return false;
  // A LocalBusiness subtype (Dentist, Plumber, Restaurant …) is named for its
  // trade, and there are hundreds; one with an address or phone is a business.
  return t.some((x) => BUSINESS_TYPES.has(x)) || "address" in node || "telephone" in node;
}

/** The best-described business on the page: an address beats a phone beats a name. */
function pickBusiness(nodes: Node[]): Node | undefined {
  let best: Node | undefined;
  let bestScore = -1;
  for (const node of nodes.filter(isBusiness)) {
    const score = ("address" in node ? 4 : 0) + ("telephone" in node ? 2 : 0) + ("name" in node ? 1 : 0);
    if (score > bestScore) {
      best = node;
      bestScore = score;
    }
  }
  return best;
}

function parseJsonLd(text: string): unknown {
  const attempts = [text, text.replace(/\/\*\s*<!\[CDATA\[\s*\*\/|\/\*\s*\]\]>\s*\*\//g, "")];
  for (const attempt of attempts) {
    try {
      return JSON.parse(attempt);
    } catch {
      // A broken block is common (trailing commas, CMS template bugs) and
      // costs only itself — the next block is still read.
    }
  }
  return undefined;
}

function first(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : value;
}

/* --------------------------------------------------------------- entry */

/**
 * Reads a business's name, description, phone, website, address and social
 * links from a page's JSON-LD and OpenGraph tags. JSON-LD wins where both
 * speak, because it is the more specific claim; OpenGraph fills the gaps.
 */
export function extractBusiness(html: string, baseUrl: string): ImportedBusiness {
  // Commented-out markup is not the page.
  const page = html.replace(/<!--[\s\S]*?-->/g, "");

  const meta = new Map<string, string>();
  for (const m of page.matchAll(META)) {
    const attrs = attributes(m[1]!);
    const key = (attrs.get("property") ?? attrs.get("name"))?.toLowerCase();
    const content = attrs.get("content");
    if (key && content !== undefined && !meta.has(key)) meta.set(key, content);
  }

  const nodes: Node[] = [];
  for (const m of page.matchAll(SCRIPT)) {
    const type = attributes(m[1]!).get("type")?.trim().toLowerCase();
    if (type !== "application/ld+json") continue;
    collect(parseJsonLd(m[2]!), nodes);
  }
  const business = pickBusiness(nodes) ?? {};

  const rawAddress = first(business["address"]);
  const address: Node =
    rawAddress !== null && typeof rawAddress === "object" ? (rawAddress as Node) : {};
  const addressText = typeof rawAddress === "string" ? rawAddress : undefined;

  let origin: string | undefined;
  try {
    origin = new URL(baseUrl).origin;
  } catch {
    origin = undefined;
  }

  const socials = [
    ...new Set(
      (Array.isArray(business["sameAs"]) ? business["sameAs"] : [business["sameAs"]])
        // Absolute links only: a profile elsewhere is never relative to this page.
        .filter((s) => typeof s === "string" && /^https?:\/\//i.test(s.trim()))
        .map((s) => httpUrl(s, baseUrl))
        .filter((s): s is string => s !== undefined),
    ),
  ];

  const result: ImportedBusiness = {
    name: clean(business["name"]) ?? clean(meta.get("og:site_name")) ?? clean(meta.get("og:title"))
      ?? clean(TITLE.exec(page)?.[1]),
    description: trimDescription(
      clean(business["description"]) ?? clean(meta.get("og:description")) ?? clean(meta.get("description")),
    ),
    phone: clean(first(business["telephone"])) ?? clean(meta.get("og:phone_number")),
    website: httpUrl(first(business["url"]), baseUrl) ?? origin,
    addressLine1: clean(address["streetAddress"]) ?? clean(addressText) ?? clean(meta.get("og:street-address")),
    city: clean(address["addressLocality"]) ?? clean(meta.get("og:locality")),
    region: clean(address["addressRegion"]) ?? clean(meta.get("og:region")),
    postcode: clean(address["postalCode"]) ?? clean(meta.get("og:postal-code")),
    socials: socials.length > 0 ? socials : undefined,
  };

  // Absent, not undefined: the caller spreads this into form defaults.
  return Object.fromEntries(
    Object.entries(result).filter(([, v]) => v !== undefined),
  ) as ImportedBusiness;
}
