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
 * No HTML parser, and no regex over the markup either.
 *
 * The page is a stranger's and this runs synchronously inside a server action,
 * so the scanner has two jobs: be tolerant (never throw on markup it cannot
 * make sense of) and be LINEAR. Regexes such as `<meta\b(...)*>` or
 * `<!--[\s\S]*?-->` retry from every candidate start and scan to the end of
 * the input when the closing token never comes — quadratic, and on a 1 MB body
 * of `<meta '` that was minutes of a blocked event loop per request. Here every
 * search is an `indexOf` or a single forward walk that the outer loop then
 * jumps past, and an unterminated construct ends the scan rather than being
 * retried from the next character.
 *
 * Only the first `MAX_SCAN_CHARS` are read. Metadata lives at the top of a
 * page; JSON-LD is sometimes in the body, which is why this is a size bound
 * rather than a cut at `</head>`.
 */
export const MAX_SCAN_CHARS = 256 * 1024;

interface Scanned {
  meta: Map<string, string>;
  title: string | undefined;
  jsonLd: string[];
}

const isSpace = (c: string | undefined): boolean =>
  c === " " || c === "\n" || c === "\t" || c === "\r" || c === "\f";

/**
 * Index of the `>` that closes the tag opened at `from`, walking quote-aware
 * so a `>` inside an attribute value does not end it. -1 if it never closes.
 */
function tagEnd(html: string, from: number): number {
  let quote: string | null = null;
  for (let i = from; i < html.length; i++) {
    const c = html[i]!;
    if (quote !== null) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === ">") {
      return i;
    }
  }
  return -1;
}

/** Name → value for the attributes in `raw` (the text between the tag name and `>`). */
function attributes(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  let i = 0;
  const n = raw.length;
  while (i < n) {
    while (i < n && (isSpace(raw[i]) || raw[i] === "/")) i++;
    const nameStart = i;
    while (i < n && !isSpace(raw[i]) && raw[i] !== "=" && raw[i] !== "/") i++;
    const name = raw.slice(nameStart, i).toLowerCase();
    if (name === "") {
      i++;
      continue;
    }
    while (i < n && isSpace(raw[i])) i++;
    let value = "";
    if (raw[i] === "=") {
      i++;
      while (i < n && isSpace(raw[i])) i++;
      const q = raw[i];
      if (q === '"' || q === "'") {
        const close = raw.indexOf(q, i + 1);
        const end = close === -1 ? n : close;
        value = raw.slice(i + 1, end);
        i = end + 1;
      } else {
        const start = i;
        while (i < n && !isSpace(raw[i])) i++;
        value = raw.slice(start, i);
      }
    }
    if (!out.has(name)) out.set(name, value);
  }
  return out;
}

/** True if `lower` has tag `name` opening at `at` (followed by space, `/` or `>`). */
function opens(lower: string, at: number, name: string): boolean {
  if (!lower.startsWith(name, at + 1)) return false;
  const next = lower[at + 1 + name.length];
  return next === undefined || next === ">" || next === "/" || isSpace(next);
}

/** One forward pass over the page for <meta>, the first <title> and ld+json scripts. */
function scan(input: string): Scanned {
  const html = input.length > MAX_SCAN_CHARS ? input.slice(0, MAX_SCAN_CHARS) : input;
  // Lower-cased once so every tag and closing-tag search is a plain indexOf.
  // ASCII only: `toLowerCase` can change a string's LENGTH ("İ" becomes two
  // code units), and every index here is shared between the two copies.
  const lower = html.replace(/[A-Z]+/g, (run) => run.toLowerCase());
  const out: Scanned = { meta: new Map(), title: undefined, jsonLd: [] };

  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt === -1) break;

    // Commented-out markup is not the page. Unterminated: the rest is comment.
    if (html.startsWith("<!--", lt)) {
      const close = html.indexOf("-->", lt + 4);
      if (close === -1) break;
      i = close + 3;
      continue;
    }

    const isMeta = opens(lower, lt, "meta");
    const isScript = !isMeta && opens(lower, lt, "script");
    const isTitle = !isMeta && !isScript && opens(lower, lt, "title");
    if (!isMeta && !isScript && !isTitle) {
      i = lt + 1;
      continue;
    }

    const nameEnd = lt + 1 + (isMeta ? 4 : isScript ? 6 : 5);
    const end = tagEnd(html, nameEnd);
    // An open tag that never closes runs to the end of the page: nothing
    // after it can be a tag, so stop rather than retry from the next `<`.
    if (end === -1) break;
    const attrs = attributes(html.slice(nameEnd, end));

    if (isMeta) {
      const key = (attrs.get("property") ?? attrs.get("name"))?.toLowerCase();
      const content = attrs.get("content");
      if (key && content !== undefined && !out.meta.has(key)) out.meta.set(key, content);
      i = end + 1;
      continue;
    }

    // <script> and <title> are raw text up to their closing tag.
    const closer = isScript ? "</script" : "</title";
    const close = lower.indexOf(closer, end + 1);
    if (close === -1) break;
    const body = html.slice(end + 1, close);
    if (isScript) {
      if (attrs.get("type")?.trim().toLowerCase() === "application/ld+json") out.jsonLd.push(body);
    } else if (out.title === undefined) {
      out.title = body;
    }
    const closeEnd = html.indexOf(">", close);
    if (closeEnd === -1) break;
    i = closeEnd + 1;
  }
  return out;
}

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—",
  rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", hellip: "…",
};

/** Bounded quantifiers: a reference is short, so no run is ever rescanned at length. */
const ENTITY = /&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{1,8});/gi;

function decodeEntities(text: string): string {
  return text.replace(ENTITY, (whole, ref: string) => {
    if (ref[0] === "#") {
      const code = ref[1] === "x" || ref[1] === "X"
        ? Number.parseInt(ref.slice(2), 16)
        : Number.parseInt(ref.slice(1), 10);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED[ref.toLowerCase()] ?? whole;
  });
}

/** Drops `<…>` runs with indexOf, so a string of unclosed `<` stays linear. */
function stripTags(text: string): string {
  let out = "";
  let i = 0;
  for (;;) {
    const lt = text.indexOf("<", i);
    if (lt === -1) return out + text.slice(i);
    const gt = text.indexOf(">", lt + 1);
    if (gt === -1) return out + text.slice(i);
    out += `${text.slice(i, lt)} `;
    i = gt + 1;
  }
}

/** Entities decoded, tags dropped, whitespace collapsed. Empty becomes undefined. */
function clean(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const text = decodeEntities(stripTags(String(value))).replace(/\s+/g, " ").trim();
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
  // Second try: from the first bracket to the last, which drops the
  // `/* <![CDATA[ */ … /* ]]> */` wrappers old CMS templates still emit.
  const open = text.search(/[{[]/);
  const close = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
  const attempts = open !== -1 && close > open ? [text, text.slice(open, close + 1)] : [text];
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
  const { meta, title, jsonLd } = scan(html);

  const nodes: Node[] = [];
  for (const block of jsonLd) collect(parseJsonLd(block), nodes);
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
      ?? clean(title),
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
