/**
 * An allow-list sanitiser for stored rich text — today, a city's `intro_html`.
 *
 * The rule this module enforces is the one `lib/blog/posts.ts` states for
 * markdown: every `<` in the output was written by this file. Nothing is
 * "stripped" — a blocklist of dangerous tags is a losing game — instead the
 * source is tokenised and only tags on the list below are re-emitted, with only
 * the attributes on the list below, so an `onerror=` or a `javascript:` href
 * has nowhere to survive.
 *
 * Only the seed writes `intro_html` today, and it escapes its own inputs. This
 * exists for the editor that will write it next: the moment copy is editable,
 * the render is the last place that can still be sure.
 */

/** What intro copy is legitimately written in. Everything else is unwrapped. */
const ALLOWED = new Set([
  "p", "br", "strong", "em", "b", "i", "a", "ul", "ol", "li", "h2", "h3", "blockquote",
]);

/** Emitted without a closing tag, and never pushed onto the open-element stack. */
const VOID = new Set(["br"]);

/**
 * Deleted with their contents, rather than unwrapped.
 *
 * Unwrapping `<script>alert(1)</script>` is safe — the text gets escaped — but
 * it renders "alert(1)" as visible copy on the page. For an element whose
 * content was never prose, dropping the content is safer and more honest.
 */
const DROP_CONTENT = new Set([
  "script", "style", "iframe", "object", "embed", "template", "noscript",
  "svg", "math", "title", "textarea", "head",
]);

/** `a[href]` is the only attribute that survives, so it is the only one schemed. */
const SAFE_SCHEME = /^(?:https?:|mailto:|tel:)/i;

/** Stripped before the scheme check: `java\nscript:` is a scheme to a browser. */
const CONTROL_CHARS = /[\u0000-\u0020\u007F-\u009F]/g;

const ESCAPES: Record<string, string> = {
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
};

function escape(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

/**
 * Decodes numeric character references.
 *
 * A browser decodes `&#106;avascript:` before resolving the URL, so checking
 * the encoded form checks a string nobody will ever navigate to.
 */
function decodeEntities(value: string): string {
  return value.replace(/&#(x?)([0-9a-f]+);?/gi, (whole, hex: string, digits: string) => {
    const code = Number.parseInt(digits, hex ? 16 : 10);
    return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
  });
}

/** True for a URL we are willing to put in an href. */
function isSafeHref(raw: string): boolean {
  const decoded = decodeEntities(raw).replace(CONTROL_CHARS, "");
  if (decoded === "") return false;

  // Protocol-relative ("//evil.test") reads as site-relative and is not: it
  // leaves the site on whatever scheme the page was served over. An author who
  // wants an external link can write the scheme.
  if (decoded.startsWith("//")) return false;

  if (decoded.startsWith("/") || decoded.startsWith("#") || decoded.startsWith("?")) return true;
  if (SAFE_SCHEME.test(decoded)) return true;

  // No scheme at all is a relative path ("about/team"). A colon BEFORE the
  // first slash is a scheme, and one we did not allow.
  const colon = decoded.indexOf(":");
  if (colon === -1) return true;
  const slash = decoded.indexOf("/");
  return slash !== -1 && slash < colon;
}

/** Reads `name`, `name=value`, `name='value'`, `name="value"` off a tag's inside. */
function readHref(attrs: string): string | null {
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const m of attrs.matchAll(re)) {
    if (m[1]?.toLowerCase() !== "href") continue;
    return m[2] ?? m[3] ?? m[4] ?? "";
  }
  return null;
}

/**
 * Finds the index just past the `>` that ends a tag opening at `start`.
 *
 * Quoted attribute values are tracked so `title="x > y"` does not end the tag
 * early — the classic way a naive `indexOf(">")` leaves attribute text loose in
 * the document. Returns -1 when the tag never closes.
 */
function endOfTag(html: string, start: number): number {
  let quote: string | null = null;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === ">") {
      return i + 1;
    }
  }
  return -1;
}

export function sanitiseRichText(html: string): string {
  const out: string[] = [];
  const open: string[] = [];
  let i = 0;

  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      out.push(escape(html.slice(i)));
      break;
    }
    if (lt > i) out.push(escape(html.slice(i, lt)));

    // Comments, doctypes and processing instructions carry nothing we want.
    if (html.startsWith("<!--", lt)) {
      const commentEnd = html.indexOf("-->", lt + 4);
      i = commentEnd === -1 ? html.length : commentEnd + 3;
      continue;
    }
    if (html.startsWith("<!", lt) || html.startsWith("<?", lt)) {
      const declEnd = html.indexOf(">", lt + 2);
      i = declEnd === -1 ? html.length : declEnd + 1;
      continue;
    }

    const tag = /^<(\/?)([a-zA-Z][a-zA-Z0-9]*)/.exec(html.slice(lt, lt + 32));
    const end = tag ? endOfTag(html, lt) : -1;
    if (!tag || end === -1) {
      // Not a tag, or a tag that never closes — a stray `<` in prose. Escape it
      // rather than guess at what the author meant.
      out.push("&lt;");
      i = lt + 1;
      continue;
    }

    const closing = tag[1] === "/";
    const name = (tag[2] ?? "").toLowerCase();
    const inside = html.slice(lt + tag[0].length, end - 1);
    i = end;

    if (DROP_CONTENT.has(name)) {
      if (closing) continue;
      // Skip to this element's own close tag; everything between is discarded.
      const close = new RegExp(`</${name}\\s*>`, "i").exec(html.slice(i));
      i = close ? i + close.index + close[0].length : html.length;
      continue;
    }

    if (!ALLOWED.has(name)) continue; // Unwrap: the children still get walked.

    if (closing) {
      // A closer with nothing matching it open is noise. Dropping it is what
      // keeps the output's nesting a function of the stack, not of the source.
      const at = open.lastIndexOf(name);
      if (at === -1) continue;
      while (open.length > at) out.push(`</${open.pop()}>`);
      continue;
    }

    if (VOID.has(name)) {
      out.push(`<${name}>`);
      continue;
    }

    const href = name === "a" ? readHref(inside) : null;
    out.push(href !== null && isSafeHref(href) ? `<a href="${escape(href.trim())}">` : `<${name}>`);
    open.push(name);
  }

  while (open.length > 0) out.push(`</${open.pop()}>`);
  return out.join("");
}
