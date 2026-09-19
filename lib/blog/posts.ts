import fs from "node:fs";
import path from "node:path";
import { postDirectories } from "@/lib/blog/demo";
import { siteUrl } from "@/lib/schema/builders";
import { prune, type JsonLd } from "@/lib/schema/types";

/**
 * The blog is files on disk, not rows in a database.
 *
 * `@next/mdx` would mean editing next.config.ts, so instead the frontmatter and
 * the markdown body are parsed here. Two rules carry all the risk:
 *
 *  - The source is HTML-escaped BEFORE any markdown is applied, so nothing a
 *    post contains — raw tags, a stray quote in a link URL — can become markup.
 *    Every tag in the output is one this file emitted.
 *  - Link hrefs are allow-listed to http(s), site-relative and fragment URLs,
 *    so `javascript:` and `data:` never reach an anchor.
 */

export interface PostMeta {
  slug: string;
  title: string;
  description: string;
  /** ISO date, `YYYY-MM-DD`. */
  date: string;
  /** Only set when the post has genuinely been revised. */
  updated?: string;
  author?: string;
  tags: string[];
  draft: boolean;
}

export interface Post extends PostMeta {
  /** Raw markdown body, frontmatter removed. */
  body: string;
  /** Sanitised HTML, ready for dangerouslySetInnerHTML. */
  html: string;
}

export type FrontmatterValue = string | string[] | boolean;

/* ------------------------------------------------------------------ escaping */

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(input: string): string {
  return input.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

/* -------------------------------------------------------------- frontmatter */

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

function unquote(raw: string): string {
  const value = raw.trim();
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' || first === "'") && first === last) return value.slice(1, -1);
  }
  return value;
}

function coerce(raw: string): FrontmatterValue {
  const value = raw.trim();
  if (value === "true") return true;
  if (value === "false") return false;
  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim();
    if (inner === "") return [];
    return inner.split(",").map(unquote).filter((s) => s !== "");
  }
  return unquote(value);
}

export interface ParsedFile {
  data: Record<string, FrontmatterValue>;
  body: string;
}

/**
 * Parses a leading `---` block of `key: value` lines. Supports inline arrays
 * (`tags: [a, b]`), block arrays (`- a` on following lines), quoted strings and
 * `true`/`false`. A file with no frontmatter block yields empty data.
 */
export function parseFrontmatter(source: string): ParsedFile {
  const normalised = source.replace(/^﻿/, "");
  const match = FRONTMATTER_RE.exec(normalised);
  if (!match || match[1] === undefined) return { data: {}, body: normalised.trim() };

  const data: Record<string, FrontmatterValue> = {};
  let currentKey: string | null = null;

  for (const line of match[1].split(/\r?\n/)) {
    if (line.trim() === "" || line.trim().startsWith("#")) continue;

    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item && currentKey !== null && item[1] !== undefined) {
      const existing = data[currentKey];
      const list = Array.isArray(existing) ? existing : [];
      list.push(unquote(item[1]));
      data[currentKey] = list;
      continue;
    }

    const pair = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!pair || pair[1] === undefined) continue;
    const key = pair[1];
    const rest = pair[2] ?? "";
    currentKey = key;
    // `tags:` with nothing after it opens a block list; seed it as an array so
    // a following `- item` has something to push onto.
    data[key] = rest.trim() === "" ? [] : coerce(rest);
  }

  return { data, body: normalised.slice(match[0].length).trim() };
}

function asString(value: FrontmatterValue | undefined): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function asList(value: FrontmatterValue | undefined): string[] {
  if (Array.isArray(value)) return value.map((v) => v.trim()).filter((v) => v !== "");
  const single = asString(value);
  return single ? [single] : [];
}

/* ---------------------------------------------------------------- markdown */

const SAFE_HREF = /^(https?:\/\/|\/|#|mailto:)/i;

/**
 * `//evil.example/x` and `/\evil.example/x` both parse as protocol-relative
 * off-site URLs while looking site-relative to the `^\/` branch above, so they
 * are rejected before the allow-list is consulted.
 */
const PROTOCOL_RELATIVE = /^\/[/\\]/;

function href(raw: string): string | null {
  const url = raw.trim();
  if (url === "") return null;
  if (PROTOCOL_RELATIVE.test(url)) return null;
  return SAFE_HREF.test(url) ? url : null;
}

/**
 * Inline markdown on ALREADY-ESCAPED text: code spans, links, bold, italic.
 * Code spans are extracted first so their contents are never re-interpreted.
 */
function inline(escaped: string): string {
  const codes: string[] = [];
  let text = escaped.replace(/`([^`]+)`/g, (_m, code: string) => {
    codes.push(code);
    return `\u0000${codes.length - 1}\u0000`;
  });

  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label: string, url: string) => {
    const safe = href(url);
    return safe === null ? label : `<a href="${safe}">${label}</a>`;
  });

  text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");

  return text.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => `<code>${codes[Number(i)] ?? ""}</code>`);
}

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const BULLET_RE = /^\s*[-*]\s+(.*)$/;
const NUMBER_RE = /^\s*\d+\.\s+(.*)$/;
const FENCE_RE = /^\s*```\s*([A-Za-z0-9+#-]*)\s*$/;

/**
 * The smallest heading level the body uses, ignoring anything inside a fence.
 * A body with no headings answers 1, which shifts nothing it would render.
 */
function topHeadingLevel(lines: string[]): number {
  let top = 6;
  let fenced = false;
  for (const line of lines) {
    if (FENCE_RE.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const heading = HEADING_RE.exec(line);
    if (heading && heading[1] !== undefined) top = Math.min(top, heading[1].length);
  }
  return top === 6 && !lines.some((l) => HEADING_RE.test(l)) ? 1 : top;
}

/**
 * Markdown → HTML. Supports headings, paragraphs, links, bold, italic,
 * ordered and unordered lists, inline code and fenced code blocks.
 *
 * The whole source is escaped up front, so markdown is only ever applied to
 * text that can no longer contain markup.
 */
export function renderMarkdown(source: string): string {
  // \u0000 is the code-span placeholder marker; strip any in the source first.
  const lines = escapeHtml(source.replace(/\r\n/g, "\n").replace(/\u0000/g, "")).split("\n");
  const out: string[] = [];
  const shift = 2 - topHeadingLevel(lines);
  let i = 0;

  // The fence marker survives escaping, but a language like `c++` does not
  // contain escapable characters either, so matching on the escaped line is safe.
  while (i < lines.length) {
    const line = lines[i] ?? "";

    if (line.trim() === "") {
      i += 1;
      continue;
    }

    const fence = FENCE_RE.exec(line);
    if (fence) {
      const lang = fence[1] ?? "";
      const buffer: string[] = [];
      i += 1;
      while (i < lines.length && !FENCE_RE.test(lines[i] ?? "")) {
        buffer.push(lines[i] ?? "");
        i += 1;
      }
      i += 1; // closing fence
      const attr = lang === "" ? "" : ` class="language-${lang}"`;
      out.push(`<pre><code${attr}>${buffer.join("\n")}</code></pre>`);
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading && heading[1] !== undefined) {
      // Shifted so the post's TOP level lands on h2: the page renders the
      // title as its h1, so a body `#` must not produce a second one, and a
      // post written from `##` down must not open with an h3 under that h1
      // (a skipped level fails the heading-order audit on every post).
      const level = Math.min(heading[1].length + shift, 6);
      out.push(`<h${level}>${inline(heading[2] ?? "")}</h${level}>`);
      i += 1;
      continue;
    }

    if (BULLET_RE.test(line) || NUMBER_RE.test(line)) {
      const ordered = !BULLET_RE.test(line);
      const re = ordered ? NUMBER_RE : BULLET_RE;
      const items: string[] = [];
      while (i < lines.length) {
        const match = re.exec(lines[i] ?? "");
        if (!match) break;
        items.push(`<li>${inline(match[1] ?? "")}</li>`);
        i += 1;
      }
      const tag = ordered ? "ol" : "ul";
      out.push(`<${tag}>${items.join("")}</${tag}>`);
      continue;
    }

    const paragraph: string[] = [];
    while (i < lines.length) {
      const next = lines[i] ?? "";
      if (
        next.trim() === "" ||
        HEADING_RE.test(next) ||
        BULLET_RE.test(next) ||
        NUMBER_RE.test(next) ||
        FENCE_RE.test(next)
      ) {
        break;
      }
      paragraph.push(next.trim());
      i += 1;
    }
    out.push(`<p>${inline(paragraph.join(" "))}</p>`);
  }

  return out.join("\n");
}

/* -------------------------------------------------------------------- posts */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Builds a post from one file's contents. Returns null if it has no title or date. */
export function toPost(slug: string, source: string): Post | null {
  const { data, body } = parseFrontmatter(source);
  const title = asString(data["title"]);
  const date = asString(data["date"]);
  if (!title || !date || !ISO_DATE.test(date)) return null;

  const updated = asString(data["updated"]);

  return {
    slug,
    title,
    description: asString(data["description"]) ?? "",
    date,
    updated: updated && ISO_DATE.test(updated) && updated !== date ? updated : undefined,
    author: asString(data["author"]),
    tags: asList(data["tags"]),
    draft: data["draft"] === true,
    body,
    html: renderMarkdown(body),
  };
}

interface PostFile {
  slug: string;
  path: string;
}

/**
 * Every `.mdx` file across the directories `postDirectories()` names, in
 * precedence order.
 *
 * The demo directory sits INSIDE the posts directory, so this read is
 * deliberately non-recursive: `readdirSync` reports `demo` as one more entry,
 * `isFile()` rejects it, and the demo posts are therefore only ever reached
 * through the second directory `postDirectories()` returns — which it only
 * returns when the demo flag is on.
 *
 * The first directory to supply a slug keeps it, so a clone's own post always
 * beats a demo fixture of the same name.
 */
function readPostFiles(): PostFile[] {
  const files: PostFile[] = [];
  const seen = new Set<string>();

  for (const dir of postDirectories()) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".mdx")) continue;
      const slug = entry.name.slice(0, -".mdx".length);
      if (seen.has(slug)) continue;
      seen.add(slug);
      files.push({ slug, path: path.join(dir, entry.name) });
    }
  }

  return files;
}

/** Newest first. Drafts are never returned. */
export function getAllPosts(): Post[] {
  const posts: Post[] = [];
  for (const file of readPostFiles()) {
    const post = toPost(file.slug, fs.readFileSync(file.path, "utf8"));
    if (post && !post.draft) posts.push(post);
  }
  return posts.sort((a, b) => (a.date === b.date ? a.slug.localeCompare(b.slug) : b.date.localeCompare(a.date)));
}

/** Every published slug — the params for `/blog/[slug]` are all known at build. */
export function getPostSlugs(): string[] {
  return getAllPosts().map((p) => p.slug);
}

export function getPost(slug: string): Post | null {
  if (!/^[a-z0-9-]+$/.test(slug)) return null;

  for (const dir of postDirectories()) {
    const file = path.join(dir, `${slug}.mdx`);
    if (!file.startsWith(dir + path.sep)) continue;
    let source: string;
    try {
      source = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const post = toPost(slug, source);
    return post && !post.draft ? post : null;
  }

  return null;
}

export function formatDate(iso: string, locale: string): string {
  const parsed = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return iso;
  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(parsed);
}

/* ------------------------------------------------------------------- schema */

/**
 * `BlogPosting` for a single post.
 *
 * The precise type, not its `Article` supertype: these are posts on a blog, at
 * /blog/[slug], listed on /blog. Schema.org's rule is to use the most specific
 * type that is true, and consumers that only understand Article still read a
 * BlogPosting as one — so the specific type costs nothing and says more.
 *
 * Built optimistically and pruned, following the convention in
 * lib/schema/builders.ts: a post with no author emits no `author` key rather
 * than an empty Person node, and `dateModified` is the revision date when there
 * has been one and the publication date otherwise — both are real.
 */
export function articleSchema(post: Post): JsonLd {
  const url = siteUrl(`/blog/${post.slug}`);
  return prune({
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    "@id": `${url}#article`,
    headline: post.title,
    description: post.description,
    url,
    mainEntityOfPage: { "@type": "WebPage", "@id": url },
    datePublished: post.date,
    dateModified: post.updated ?? post.date,
    author: post.author ? { "@type": "Person", name: post.author } : undefined,
    keywords: post.tags,
    publisher: { "@id": siteUrl("#organization") },
    isPartOf: { "@id": siteUrl("#website") },
  });
}
