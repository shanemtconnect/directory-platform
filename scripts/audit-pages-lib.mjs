/**
 * The pure half of scripts/audit-pages.mjs: everything that can be unit-tested
 * without a browser. Page selection from a sitemap, thresholds from the
 * environment, pass/fail verdicts and the table. The orchestrator owns Chrome.
 *
 * Plain ESM with JSDoc types rather than TypeScript so the audit runs under
 * `node` with no loader, the same way scripts/migrate.mjs does.
 */

/** @typedef {"performance" | "accessibility" | "best-practices" | "seo"} Category */
/** @typedef {"mobile" | "desktop"} FormFactor */

/** @type {readonly Category[]} */
export const CATEGORIES = ["performance", "accessibility", "best-practices", "seo"];

/** @type {readonly FormFactor[]} */
export const FORM_FACTORS = ["mobile", "desktop"];

/**
 * Lighthouse category minimums, 0–100. The brief's numbers; overridable from
 * the environment so a clone with heavier pages can loosen performance without
 * editing the script (`AUDIT_MIN_PERFORMANCE=70`), and CI can tighten it.
 *
 * Performance is judged on BOTH form factors at the same bar. Desktop scores
 * higher than mobile on the same page, so a mobile-only bar would let a
 * desktop regression through; the brief's "≥ 80 (mobile)" is the floor, not
 * the only place it applies.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {Record<Category, number>}
 */
export function thresholdsFromEnv(env) {
  /** @param {string} key @param {number} fallback */
  const read = (key, fallback) => {
    const raw = env[key];
    if (raw === undefined || raw.trim() === "") return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0 || n > 100) {
      throw new Error(`${key} must be a number from 0 to 100, got ${JSON.stringify(raw)}`);
    }
    return n;
  };
  return {
    performance: read("AUDIT_MIN_PERFORMANCE", 80),
    accessibility: read("AUDIT_MIN_ACCESSIBILITY", 95),
    "best-practices": read("AUDIT_MIN_BEST_PRACTICES", 90),
    seo: read("AUDIT_MIN_SEO", 95),
  };
}

/**
 * The axe impact levels that fail the run. `moderate` and `minor` are reported
 * but do not fail: they are real, and they are also the ones that turn into
 * noise the moment a third-party widget is on the page.
 *
 * @type {ReadonlySet<string>}
 */
export const FAILING_IMPACTS = new Set(["serious", "critical"]);

/**
 * @typedef {object} AxeViolation
 * @property {string} id
 * @property {string | null | undefined} impact
 * @property {string} help
 * @property {{ target: unknown[] }[]} nodes
 */

/**
 * The violations that fail the page, in a shape the table can print.
 *
 * @param {AxeViolation[]} violations
 * @returns {{ id: string; impact: string; help: string; nodes: number }[]}
 */
export function failingViolations(violations) {
  return violations
    .filter((v) => typeof v.impact === "string" && FAILING_IMPACTS.has(v.impact))
    .map((v) => ({
      id: v.id,
      impact: /** @type {string} */ (v.impact),
      help: v.help,
      nodes: v.nodes.length,
    }));
}

/**
 * @typedef {object} PageResult
 * @property {string} name        The page type, e.g. "city pillar".
 * @property {string} path        What was requested.
 * @property {string} finalUrl    Where the browser ended up (a redirect shows here).
 * @property {number | null} status  HTTP status of the document, if known.
 * @property {Partial<Record<FormFactor, Partial<Record<Category, number | null>>>>} lighthouse
 *   Scores 0–100; `null` when Lighthouse could not score the category. A form
 *   factor absent from the map was not run (a 4xx page, see the orchestrator).
 * @property {{ id: string; impact: string; help: string; nodes: number }[]} axe
 *   The serious/critical violations. Empty is a pass.
 * @property {string[]} notes  Anything the reader should know that is not a miss.
 * @property {string[]} errors Run-time failures — a page that would not load, a
 *   Lighthouse crash. Any error fails the page.
 */

/**
 * Every reason a page misses the bar. Empty means it passed.
 *
 * @param {PageResult} result
 * @param {Record<Category, number>} thresholds
 * @returns {string[]}
 */
export function pageMisses(result, thresholds) {
  /** @type {string[]} */
  const misses = [...result.errors];
  for (const factor of FORM_FACTORS) {
    const scores = result.lighthouse[factor];
    if (!scores) continue;
    for (const category of CATEGORIES) {
      const score = scores[category];
      const min = thresholds[category];
      if (score === null || score === undefined) {
        misses.push(`${factor} ${category}: no score`);
      } else if (score < min) {
        misses.push(`${factor} ${category}: ${score} < ${min}`);
      }
    }
  }
  for (const v of result.axe) {
    misses.push(`axe ${v.impact} ${v.id} (${v.nodes} node${v.nodes === 1 ? "" : "s"}): ${v.help}`);
  }
  return misses;
}

/**
 * @param {PageResult[]} results
 * @param {Record<Category, number>} thresholds
 * @returns {{ passed: PageResult[]; failed: { result: PageResult; misses: string[] }[] }}
 */
export function summarise(results, thresholds) {
  /** @type {PageResult[]} */
  const passed = [];
  /** @type {{ result: PageResult; misses: string[] }[]} */
  const failed = [];
  for (const result of results) {
    const misses = pageMisses(result, thresholds);
    if (misses.length === 0) passed.push(result);
    else failed.push({ result, misses });
  }
  return { passed, failed };
}

/** @param {number | null | undefined} score */
const cell = (score) => (score === null || score === undefined ? "  –" : String(score).padStart(3));

/**
 * One row per page: the four mobile scores, the four desktop scores, the axe
 * verdict. Plain text, fixed columns, no dependency — it has to print in a CI
 * log as well as a terminal.
 *
 * @param {PageResult[]} results
 * @param {Record<Category, number>} thresholds
 * @returns {string}
 */
export function formatTable(results, thresholds) {
  const nameWidth = Math.max(4, ...results.map((r) => r.name.length));
  const pathWidth = Math.max(4, ...results.map((r) => r.path.length));
  const head =
    `${"page".padEnd(nameWidth)}  ${"path".padEnd(pathWidth)}  `
    + "mobile P/A/B/S     desktop P/A/B/S    axe   result";
  const lines = [head, "-".repeat(head.length)];
  for (const r of results) {
    const misses = pageMisses(r, thresholds);
    /** @param {FormFactor} factor */
    const block = (factor) => {
      const s = r.lighthouse[factor];
      if (!s) return "   –   –   –   –  ";
      return CATEGORIES.map((c) => cell(s[c])).join(" ") + "  ";
    };
    const axe = r.axe.length === 0 ? "ok " : `${r.axe.length}!`.padEnd(3);
    lines.push(
      `${r.name.padEnd(nameWidth)}  ${r.path.padEnd(pathWidth)}  `
      + `${block("mobile")} ${block("desktop")} ${axe}   ${misses.length === 0 ? "PASS" : "FAIL"}`,
    );
  }
  lines.push(
    "",
    `thresholds: performance ≥ ${thresholds.performance}, accessibility ≥ ${thresholds.accessibility}, `
    + `best-practices ≥ ${thresholds["best-practices"]}, seo ≥ ${thresholds.seo}; `
    + "axe fails on serious/critical",
  );
  return lines.join("\n");
}

/**
 * Sitemap shards contain only what the site advertises. Everything the audit
 * needs is derived from them so no slug is ever hardcoded: the seed changes,
 * a clone has different cities, and the script still finds a real page.
 *
 * @typedef {object} SitemapPaths
 * @property {string[]} statics     `/`, `/cities`, `/pricing`, ... and `/blog/<slug>`
 * @property {string[]} cities      `/<city>`
 * @property {string[]} categories  `/categories/<slug>`
 * @property {string[]} listings    `/<city>/<listing>`
 */

/**
 * Splits every <loc> path from every shard into the four kinds, using the
 * listing shard to tell a city from a static route: a city is a one-segment
 * path that some listing lives under.
 *
 * @param {string[]} paths  Pathnames from every shard, e.g. "/leeds/the-mill".
 * @returns {SitemapPaths}
 */
export function classifySitemapPaths(paths) {
  // Region pages live under /areas and would otherwise be read as listings of
  // a city called "areas" — the busiest "city" in any seed with many regions.
  const regions = paths.filter((p) => /^\/areas\/[^/]+$/.test(p));
  const listings = paths.filter(
    (p) =>
      /^\/[^/]+\/[^/]+$/.test(p)
      && !p.startsWith("/categories/")
      && !p.startsWith("/blog/")
      && !p.startsWith("/areas/"),
  );
  const citySlugs = new Set(listings.map((p) => p.split("/")[1]));
  const cities = paths.filter((p) => /^\/[^/]+$/.test(p) && citySlugs.has(p.slice(1)));
  const categories = paths.filter((p) => /^\/categories\/[^/]+$/.test(p));
  const statics = paths.filter(
    (p) => !cities.includes(p) && !categories.includes(p) && !listings.includes(p) && !regions.includes(p),
  );
  return { statics, cities, categories, listings, regions };
}

/**
 * The city with the most listings in the sitemap: the one most likely to have
 * a second page of results and a category with more than one entry.
 *
 * @param {SitemapPaths} sitemap
 * @returns {string | null}  The city slug, or null when the sitemap has none.
 */
export function busiestCity(sitemap) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const p of sitemap.listings) {
    const city = p.split("/")[1];
    if (city === undefined) continue;
    counts.set(city, (counts.get(city) ?? 0) + 1);
  }
  let best = null;
  let bestCount = -1;
  for (const [city, n] of counts) {
    if (n > bestCount || (n === bestCount && best !== null && city < best)) {
      best = city;
      bestCount = n;
    }
  }
  return best;
}

/**
 * Finds a `/<city>/<category>` link in a city pillar's HTML — the pillar
 * links every category it has listings in, so the first that matches a known
 * category slug is a real, non-empty city+category page.
 *
 * @param {string} html
 * @param {string} city
 * @param {string[]} categorySlugs
 * @returns {string | null}
 */
export function cityCategoryPathFromHtml(html, city, categorySlugs) {
  const known = new Set(categorySlugs);
  const re = new RegExp(`href="/${escapeRegExp(city)}/([a-z0-9-]+)"`, "g");
  for (const match of html.matchAll(re)) {
    const slug = match[1];
    if (slug !== undefined && known.has(slug)) return `/${city}/${slug}`;
  }
  return null;
}

/**
 * A listing's id from its detail page: the report link carries it, and the
 * claim and review pages take the same id.
 *
 * @param {string} html
 * @returns {string | null}
 */
export function listingIdFromHtml(html) {
  const m = /href="\/report\/([0-9a-f-]{36})"/.exec(html);
  return m?.[1] ?? null;
}

/** @param {string} s */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Which pages to audit, derived from what the site advertises plus the forms
 * and utility pages the brief names. Slugs come from `sitemap`, the listing id
 * from `listingId`, the city+category path from the pillar's HTML.
 *
 * Each entry is `{ name, path, expectStatus }`. `expectStatus` is what the
 * DOCUMENT should return; the orchestrator fails a page whose status differs,
 * because a 404 where a pillar should be is a broken site, not a slow one.
 *
 * @param {object} input
 * @param {SitemapPaths} input.sitemap
 * @param {string | null} input.cityCategoryPath
 * @param {string | null} input.listingId
 * @param {boolean} input.hasSecondPage   Whether `/<city>/page/2` returned 200.
 * @returns {{ pages: { name: string; path: string; expectStatus: number }[]; skipped: string[] }}
 */
export function selectPages({ sitemap, cityCategoryPath, listingId, hasSecondPage }) {
  /** @type {{ name: string; path: string; expectStatus: number }[]} */
  const pages = [];
  /** @type {string[]} */
  const skipped = [];
  /** @param {string} name @param {string | null} path */
  const add = (name, path, expectStatus = 200) => {
    if (path === null) skipped.push(`${name}: nothing in the sitemap to derive it from`);
    else pages.push({ name, path, expectStatus });
  };

  const city = busiestCity(sitemap);
  const listing = city === null ? null : (sitemap.listings.find((p) => p.startsWith(`/${city}/`)) ?? null);
  const blog = sitemap.statics.find((p) => /^\/blog\/[^/]+$/.test(p)) ?? null;

  add("home", "/");
  add("cities index", "/cities");
  add("categories index", "/categories");
  add("city pillar", city === null ? null : `/${city}`);
  add("city + category", cityCategoryPath);
  add("category", sitemap.categories[0] ?? null);
  // Region pages are optional (niche-national mode only); a site without them
  // records a skip rather than auditing a 404.
  const regions = sitemap.regions ?? [];
  if (regions.length > 0) {
    add("regions index", "/areas");
    add("region pillar", regions[0] ?? null);
  } else {
    skipped.push("regions: nothing in the sitemap under /areas");
  }
  add("listing detail", listing);
  if (city !== null && hasSecondPage) add("pagination", `/${city}/page/2`);
  else skipped.push("pagination: no city in the sitemap has a second page of listings");
  add("search", `/search?q=${encodeURIComponent(city ?? "a")}`);
  add("pricing", "/pricing");
  add("advertise badge", "/advertise/badge");
  add("login", "/login");
  add("signup", "/signup");
  add("add listing", "/add-listing");
  add("claim", listingId === null ? null : `/claim/${listingId}`);
  add("report", listingId === null ? null : `/report/${listingId}`);
  add("leave review", listingId === null ? null : `/leave-review/${listingId}`);
  add("forgot password", "/forgot-password");
  add("privacy", "/privacy");
  add("terms", "/terms");
  add("blog post", blog);
  add("404", "/this-page-does-not-exist-audit", 404);
  return { pages, skipped };
}

/**
 * `AUDIT_PAGES=home,login` narrows a run to the named page types while you
 * chase one fix. Empty means everything.
 *
 * @template {{ name: string }} T
 * @param {T[]} pages
 * @param {string | undefined} filter
 * @returns {T[]}
 */
export function filterPages(pages, filter) {
  if (filter === undefined || filter.trim() === "") return pages;
  const wanted = new Set(filter.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
  return pages.filter((p) => wanted.has(p.name.toLowerCase()));
}

/**
 * A page that says `noindex` on purpose — login, signup, search results, the
 * claim flow — can never pass Lighthouse's `is-crawlable` audit, and that
 * audit alone takes the SEO category from 100 to the low 60s. Failing the
 * gate on it would either force those pages into the index or teach everyone
 * to ignore the SEO column, so on a page whose own document declares noindex
 * the category is re-scored from its remaining audits: the same weighted mean
 * Lighthouse uses, minus that one ref. Every other SEO audit still counts.
 *
 * Whether the page declares noindex is decided from the HTML and headers the
 * script fetched itself (`declaresNoindex`), never from the audit's verdict,
 * so a page that is blocked by accident — a stray header, a robots.txt rule —
 * still fails.
 *
 * @param {{ auditRefs: { id: string; weight: number }[] } | undefined} category
 * @param {Record<string, { score: number | null } | undefined>} audits
 * @returns {number | null}  0–100, or null when nothing is left to score.
 */
export function seoScoreIgnoringCrawlability(category, audits) {
  if (category === undefined) return null;
  let weight = 0;
  let total = 0;
  for (const ref of category.auditRefs) {
    if (ref.id === "is-crawlable" || ref.weight <= 0) continue;
    const score = audits[ref.id]?.score;
    if (typeof score !== "number") continue;
    weight += ref.weight;
    total += ref.weight * score;
  }
  return weight === 0 ? null : Math.round((total / weight) * 100);
}

/**
 * Whether the DOCUMENT itself asks not to be indexed: a robots meta tag or an
 * X-Robots-Tag header carrying `noindex` or `none`. Only what the page
 * declares counts; the audit script decides nothing from Lighthouse here.
 *
 * @param {{ html: string; robotsHeader: string | null }} doc
 * @returns {boolean}
 */
export function declaresNoindex(doc) {
  const header = doc.robotsHeader?.toLowerCase() ?? "";
  if (/\b(noindex|none)\b/.test(header)) return true;
  const meta = /<meta\s+[^>]*name=["'](?:robots|googlebot)["'][^>]*>/gi;
  for (const tag of doc.html.matchAll(meta)) {
    const content = /content=["']([^"']*)["']/i.exec(tag[0])?.[1]?.toLowerCase() ?? "";
    if (/\b(noindex|none)\b/.test(content)) return true;
  }
  return false;
}
