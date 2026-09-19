#!/usr/bin/env node
/**
 * Lighthouse + axe-core audit of every page TYPE the site serves, against a
 * running production build.
 *
 *   AUDIT_BASE_URL=http://localhost:3241 corepack pnpm audit:pages
 *
 * What it does, in order:
 *   1. Reads /sitemap.xml and every shard it names, and derives real slugs
 *      from them — the busiest city, a listing in it, a category it links to,
 *      a blog post — so nothing here is hardcoded to one seed.
 *   2. Runs Lighthouse on each page, mobile and desktop, and checks the four
 *      category scores against the thresholds (scripts/audit-pages-lib.mjs,
 *      overridable with AUDIT_MIN_PERFORMANCE / _ACCESSIBILITY /
 *      _BEST_PRACTICES / _SEO).
 *   3. Runs axe-core on the same pages through Playwright and fails on any
 *      serious or critical violation.
 *   4. Prints a table, writes audit-report.json (gitignored), exits 1 on any
 *      miss.
 *
 * Environment:
 *   AUDIT_BASE_URL      server under test (default http://localhost:3241)
 *   AUDIT_PAGES         comma-separated page names to run, e.g. "home,login"
 *   AUDIT_FORM_FACTORS  "mobile", "desktop" or "mobile,desktop" (default both)
 *   AUDIT_REPORT        where to write the JSON (default ./audit-report.json)
 *   CHROME_PATH         a Chrome binary for Lighthouse; without it, an
 *                       installed Google Chrome is used, and failing that
 *                       Playwright's Chromium (`playwright install chromium`)
 *
 * A 4xx page (the 404 test) gets axe only: Lighthouse refuses to score a
 * document whose status is an error, by design, so the 404 page is checked
 * for accessibility and for returning 404, not for performance.
 *
 * Runs are sequential on purpose. Lighthouse's performance score is measured,
 * and two audits sharing a CPU measure each other.
 */
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
import * as chromeLauncher from "chrome-launcher";
import lighthouse from "lighthouse";
import desktopConfig from "lighthouse/core/config/desktop-config.js";
import {
  CATEGORIES,
  FORM_FACTORS,
  cityCategoryPathFromHtml,
  classifySitemapPaths,
  busiestCity,
  declaresNoindex,
  failingViolations,
  filterPages,
  formatTable,
  listingIdFromHtml,
  selectPages,
  seoScoreIgnoringCrawlability,
  summarise,
  thresholdsFromEnv,
} from "./audit-pages-lib.mjs";

/** @typedef {import("./audit-pages-lib.mjs").PageResult} PageResult */
/** @typedef {import("./audit-pages-lib.mjs").FormFactor} FormFactor */
/** @typedef {import("./audit-pages-lib.mjs").Category} Category */

const BASE_URL = (process.env.AUDIT_BASE_URL ?? "http://localhost:3241").replace(/\/$/, "");
const REPORT_PATH = resolve(process.env.AUDIT_REPORT ?? "audit-report.json");
const thresholds = thresholdsFromEnv(process.env);
const formFactors = parseFormFactors(process.env.AUDIT_FORM_FACTORS);

/**
 * @param {string | undefined} raw
 * @returns {FormFactor[]}
 */
function parseFormFactors(raw) {
  if (raw === undefined || raw.trim() === "") return [...FORM_FACTORS];
  const wanted = raw.split(",").map((s) => s.trim());
  for (const w of wanted) {
    if (!FORM_FACTORS.includes(/** @type {FormFactor} */ (w))) {
      throw new Error(`AUDIT_FORM_FACTORS: unknown form factor ${JSON.stringify(w)}`);
    }
  }
  return /** @type {FormFactor[]} */ (wanted);
}

/** @param {string} path */
async function fetchText(path) {
  const res = await fetch(`${BASE_URL}${path}`, { redirect: "manual" });
  return {
    status: res.status,
    text: await res.text(),
    location: res.headers.get("location"),
    robotsHeader: res.headers.get("x-robots-tag"),
  };
}

/** @param {string} xml */
function locs(xml) {
  return Array.from(xml.matchAll(/<loc>([^<]+)<\/loc>/g), (m) => m[1] ?? "");
}

/** Every path in every shard the index names. */
async function sitemapPaths() {
  const index = await fetchText("/sitemap.xml");
  if (index.status !== 200) throw new Error(`/sitemap.xml returned ${index.status}`);
  const shards = locs(index.text);
  if (shards.length === 0) {
    throw new Error("/sitemap.xml names no shards — is SITE_ENV=production set on the server?");
  }
  /** @type {string[]} */
  const paths = [];
  for (const shard of shards) {
    const path = new URL(shard).pathname;
    const res = await fetchText(path);
    if (res.status !== 200) throw new Error(`${path} returned ${res.status}`);
    paths.push(...locs(res.text).map((u) => new URL(u).pathname));
  }
  return paths;
}

/** The pages to audit, with every slug derived from the running site. */
async function discoverPages() {
  const sitemap = classifySitemapPaths(await sitemapPaths());
  const city = busiestCity(sitemap);
  /** @type {string | null} */
  let cityCategoryPath = null;
  /** @type {string | null} */
  let listingId = null;
  let hasSecondPage = false;

  if (city !== null) {
    const pillar = await fetchText(`/${city}`);
    const categorySlugs = sitemap.categories.map((p) => p.split("/")[2] ?? "");
    cityCategoryPath = cityCategoryPathFromHtml(pillar.text, city, categorySlugs);
    hasSecondPage = (await fetchText(`/${city}/page/2`)).status === 200;
    const listing = sitemap.listings.find((p) => p.startsWith(`/${city}/`));
    if (listing !== undefined) listingId = listingIdFromHtml((await fetchText(listing)).text);
  }

  const selected = selectPages({ sitemap, cityCategoryPath, listingId, hasSecondPage });
  return { pages: filterPages(selected.pages, process.env.AUDIT_PAGES), skipped: selected.skipped };
}

/**
 * A Chrome for Lighthouse. chrome-launcher honours CHROME_PATH and otherwise
 * looks for an installed Chrome; CI has neither, but it has the Chromium that
 * Playwright installed for the e2e suite, which is the fallback.
 */
async function launchChrome() {
  /** @type {string | undefined} */
  let chromePath = process.env.CHROME_PATH;
  if (chromePath === undefined) {
    try {
      chromeLauncher.getChromePath();
    } catch {
      chromePath = chromium.executablePath();
    }
  }
  return chromeLauncher.launch({
    chromePath,
    chromeFlags: ["--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
  });
}

/** @returns {Record<Category, number | null>} */
function emptyScores() {
  return { performance: null, accessibility: null, "best-practices": null, seo: null };
}

/**
 * The failing Lighthouse audits for a category, for the report — the table
 * says a score is 87; this says why.
 *
 * @param {import("lighthouse").Result} lhr
 * @param {Category} category
 */
function failingAudits(lhr, category) {
  const refs = lhr.categories[category]?.auditRefs ?? [];
  return refs
    .map((ref) => lhr.audits[ref.id])
    .filter((a) => a !== undefined && a.score !== null && a.score < 1 && a.scoreDisplayMode !== "informative")
    .map((a) => ({
      id: a.id,
      title: a.title,
      score: a.score,
      displayValue: a.displayValue ?? null,
      // The first few offending nodes, so the report says WHICH heading or
      // link, not just that one exists.
      items: itemsOf(a).slice(0, 5),
    }));
}

/**
 * @param {import("lighthouse").Result.AuditResult} audit
 * @returns {unknown[]}
 */
function itemsOf(audit) {
  const details = audit.details;
  if (details === undefined || !("items" in details) || !Array.isArray(details.items)) return [];
  return details.items.map((item) => {
    if (typeof item !== "object" || item === null) return item;
    const record = /** @type {Record<string, unknown>} */ (item);
    const node = record.node;
    if (typeof node === "object" && node !== null && "snippet" in node) {
      return { snippet: /** @type {{ snippet?: unknown }} */ (node).snippet, ...omit(record, "node") };
    }
    return record;
  });
}

/**
 * @param {Record<string, unknown>} record
 * @param {string} key
 */
function omit(record, key) {
  const { [key]: _dropped, ...rest } = record;
  return rest;
}

/**
 * @param {string} url
 * @param {FormFactor} formFactor
 * @param {number} port
 * @param {boolean} noindex  The document declares noindex; see seoScoreIgnoringCrawlability.
 */
async function lighthouseDetail(url, formFactor, port, noindex) {
  const result = await lighthouse(
    url,
    { port, output: "json", logLevel: "error", onlyCategories: [...CATEGORIES] },
    formFactor === "desktop" ? desktopConfig : undefined,
  );
  if (result === undefined) return { scores: emptyScores(), finalUrl: url, error: "Lighthouse returned nothing", failing: {} };
  const lhr = result.lhr;
  const scores = emptyScores();
  /** @type {Partial<Record<Category, ReturnType<typeof failingAudits>>>} */
  const failing = {};
  for (const category of CATEGORIES) {
    const score = lhr.categories[category]?.score;
    scores[category] = typeof score === "number" ? Math.round(score * 100) : null;
    if (category === "seo" && noindex) {
      scores.seo = seoScoreIgnoringCrawlability(lhr.categories.seo, lhr.audits);
    }
    const misses = failingAudits(lhr, category).filter((a) => !(noindex && a.id === "is-crawlable"));
    if (misses.length > 0) failing[category] = misses;
  }
  const runtimeError = lhr.runtimeError ? `${lhr.runtimeError.code}: ${lhr.runtimeError.message}` : null;
  return { scores, finalUrl: lhr.finalDisplayedUrl, error: runtimeError, failing };
}

/**
 * @param {import("@playwright/test").Browser} browser
 * @param {string} url
 */
async function runAxe(browser, url) {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    // "load", not "networkidle": the Turnstile widget on every form page polls
    // its origin for as long as the page is open, so the network never idles.
    const response = await page.goto(url, { waitUntil: "load" });
    const status = response?.status() ?? null;
    const results = await new AxeBuilder({ page }).analyze();
    return {
      status,
      finalUrl: page.url(),
      failing: failingViolations(results.violations),
      all: results.violations.map((v) => ({
        id: v.id,
        impact: v.impact ?? null,
        help: v.help,
        nodes: v.nodes.map((n) => n.target.map(String).join(" ")),
      })),
    };
  } finally {
    await context.close();
  }
}

async function main() {
  console.log(`audit: ${BASE_URL}`);
  const { pages, skipped } = await discoverPages();
  for (const s of skipped) console.log(`  skipped ${s}`);
  if (pages.length === 0) throw new Error("nothing to audit");
  console.log(`  ${pages.length} page${pages.length === 1 ? "" : "s"}, ${formFactors.join(" + ")}`);

  const chrome = await launchChrome();
  const browser = await chromium.launch();
  /** @type {PageResult[]} */
  const results = [];
  /** @type {Record<string, unknown>[]} */
  const details = [];

  try {
    for (const target of pages) {
      const url = `${BASE_URL}${target.path}`;
      /** @type {PageResult} */
      const result = {
        name: target.name,
        path: target.path,
        finalUrl: url,
        status: null,
        lighthouse: {},
        axe: [],
        notes: [],
        errors: [],
      };
      /** @type {Record<string, unknown>} */
      const detail = { name: target.name, path: target.path };
      process.stdout.write(`  ${target.name.padEnd(18)} ${target.path} ... `);

      try {
        const axe = await runAxe(browser, url);
        result.status = axe.status;
        result.finalUrl = axe.finalUrl;
        result.axe = axe.failing;
        detail.axe = axe.all;
        if (axe.status !== target.expectStatus) {
          result.errors.push(`expected HTTP ${target.expectStatus}, got ${axe.status ?? "no response"}`);
        }
        if (axe.finalUrl !== url) result.notes.push(`redirected to ${axe.finalUrl.replace(BASE_URL, "")}`);

        if (target.expectStatus >= 400) {
          result.notes.push("Lighthouse skipped: it does not score an error document");
        } else {
          // What the browser ended up on, not what was asked for: a redirect
          // to /login is scored as the login page, noindex and all.
          const doc = await fetchText(axe.finalUrl.replace(BASE_URL, ""));
          const noindex = declaresNoindex({ html: doc.text, robotsHeader: doc.robotsHeader });
          if (noindex) result.notes.push("declares noindex; SEO scored without is-crawlable");
          for (const factor of formFactors) {
            const lh = await lighthouseDetail(url, factor, chrome.port, noindex);
            result.lighthouse[factor] = lh.scores;
            if (lh.error !== null) result.errors.push(`${factor} Lighthouse: ${lh.error}`);
            detail[`lighthouse-${factor}`] = { scores: lh.scores, failingAudits: lh.failing };
          }
        }
      } catch (err) {
        result.errors.push(err instanceof Error ? err.message : String(err));
      }

      const line = FORM_FACTORS.map((f) => {
        const s = result.lighthouse[f];
        return s ? `${f[0]}:${CATEGORIES.map((c) => s[c] ?? "–").join("/")}` : null;
      }).filter(Boolean).join(" ");
      console.log(`${line} axe:${result.axe.length} ${result.errors.length ? "ERR" : ""}`.trim());
      results.push(result);
      details.push(detail);
    }
  } finally {
    await browser.close();
    await chrome.kill();
  }

  const summary = summarise(results, thresholds);
  console.log("");
  console.log(formatTable(results, thresholds));
  for (const { result, misses } of summary.failed) {
    console.log(`\n${result.name} (${result.path}) FAILED:`);
    for (const m of misses) console.log(`  - ${m}`);
  }
  for (const r of results) {
    for (const n of r.notes) console.log(`note: ${r.name}: ${n}`);
  }

  await writeFile(
    REPORT_PATH,
    JSON.stringify(
      {
        baseUrl: BASE_URL,
        generatedAt: new Date().toISOString(),
        thresholds,
        formFactors,
        skipped,
        results,
        details,
        passed: summary.failed.length === 0,
      },
      null,
      2,
    ),
  );
  console.log(`\nreport: ${REPORT_PATH}`);
  console.log(`${summary.passed.length} passed, ${summary.failed.length} failed`);
  process.exitCode = summary.failed.length === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exitCode = 1;
});
