import { describe, it, expect, afterEach } from "vitest";
import { siteEnv, isStaging, siteOrigin, NOINDEX_HEADER } from "./site-env";
import { siteConfig } from "@/config/site.config";

const original = process.env.SITE_ENV;
const originalUrl = process.env.NEXT_PUBLIC_SITE_URL;
afterEach(() => {
  process.env.SITE_ENV = original;
  if (originalUrl === undefined) delete process.env.NEXT_PUBLIC_SITE_URL;
  else process.env.NEXT_PUBLIC_SITE_URL = originalUrl;
});

describe("siteOrigin", () => {
  it("uses NEXT_PUBLIC_SITE_URL when it is set", () => {
    process.env.NEXT_PUBLIC_SITE_URL = "https://staging.example.test";
    expect(siteOrigin()).toBe("https://staging.example.test");
  });

  it("falls back to the configured domain", () => {
    delete process.env.NEXT_PUBLIC_SITE_URL;
    expect(siteOrigin()).toBe(`https://${siteConfig.domain}`);
  });

  it("never leaves a trailing slash, so no URL it builds has a double one", () => {
    process.env.NEXT_PUBLIC_SITE_URL = "https://example.test//";
    expect(siteOrigin()).toBe("https://example.test");
    expect(new URL(siteOrigin())).toBeInstanceOf(URL);
  });
});

describe("siteEnv", () => {
  it("is production only for the exact string 'production'", () => {
    process.env.SITE_ENV = "production";
    expect(siteEnv()).toBe("production");
    expect(isStaging()).toBe(false);
  });

  it("defaults to staging when unset — indexing must be opted into", () => {
    // The asymmetric direction on purpose. A production site that forgets the
    // variable serves noindex until someone notices and rebuilds: a bad day.
    // A staging site that forgets it gets indexed, and de-indexing a staging
    // copy of the whole directory takes months.
    delete process.env.SITE_ENV;
    expect(siteEnv()).toBe("staging");
    expect(isStaging()).toBe(true);
  });

  it("treats every near-miss spelling as staging, not production", () => {
    // Including "Production" and "PRODUCTION": a case-insensitive match would
    // mean the safe default depends on how someone typed it into a deploy UI.
    for (const v of ["staging", "Staging", "STAGING", "stage", "prod", "Production", "PRODUCTION", "true", "1", ""]) {
      process.env.SITE_ENV = v;
      expect(siteEnv(), v).toBe("staging");
      expect(isStaging(), v).toBe(true);
    }
  });

  it("sends the directives that actually stop indexing, not just noindex", () => {
    // nofollow stops staging links leaking equity; noarchive/nosnippet stop a
    // cached copy surviving after the site is taken down.
    for (const d of ["noindex", "nofollow", "noarchive", "nosnippet", "noimageindex"]) {
      expect(NOINDEX_HEADER).toContain(d);
    }
  });
});

describe("next.config header duplication", () => {
  it("keeps next.config's inlined noindex header in step with lib/site-env", async () => {
    // The header is set in next.config.ts (headers() runs in Node; middleware's
    // Edge runtime cannot resolve node:crypto in standalone mode). The string is
    // duplicated there, and this test is what stops the two drifting.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../next.config.ts", import.meta.url), "utf8");
    expect(src).toContain(NOINDEX_HEADER);
    // The same fail-safe test as siteEnv(): production is opted into, and
    // anything else — unset included — gets the header. `=== "production"`
    // returning [] is the early-out for a production build; every other value
    // falls through to the noindex header.
    expect(src).toContain('process.env.SITE_ENV === "production"');
  });
});

/**
 * SITE_ENV is a BUILD-TIME switch. Flipping staging -> production is a REBUILD.
 *
 * Two mechanisms, only one of which can be changed at boot:
 *
 *  - `X-Robots-Tag` comes from `next.config.ts` `headers()`, which Next
 *    evaluates during `next build` and writes into `.next/routes-manifest.json`.
 *    The standalone server reads that file and never re-runs `headers()`, so
 *    the header a container serves is the one the BUILD decided on. Setting
 *    SITE_ENV at boot cannot add it or remove it.
 *  - `app/robots.ts` and the sitemap read `siteEnv()` per request (robots.ts is
 *    `force-dynamic` for exactly this reason), so those DO follow a boot value.
 *
 * A deploy that flips only the runtime variable therefore gets a site that
 * says "Allow: /" in robots.txt while every response still carries
 * `X-Robots-Tag: noindex` — a site that looks fixed and is not.
 */
describe("SITE_ENV is a build-time switch", () => {
  it("bakes the noindex header into routes-manifest.json, not into a request", async () => {
    const { readFileSync } = await import("node:fs");
    const config = readFileSync(new URL("../next.config.ts", import.meta.url), "utf8");

    // `headers()` reads process.env at build time. If this ever moved to
    // middleware or a per-request header, the build-time claim above — and the
    // "rebuild to flip" instructions in README.md and docs/CLONING.md — would
    // be wrong, and this assertion is what would catch it.
    expect(config).toMatch(/async headers\(\)/);
    expect(config).toContain("BUILD-TIME");

    // robots.txt is the half that does follow a boot value, and it can only do
    // that because it is force-dynamic. A force-static robots route would be
    // cached forever with whatever the build decided.
    const robots = readFileSync(new URL("../app/robots.ts", import.meta.url), "utf8");
    expect(robots).toContain('export const dynamic = "force-dynamic"');
  });

  it("is documented as build-time in both README and CLONING", async () => {
    const { readFileSync } = await import("node:fs");
    for (const doc of ["../README.md", "../docs/CLONING.md"]) {
      const src = readFileSync(new URL(doc, import.meta.url), "utf8");
      expect(src, doc).toContain("SITE_ENV");
      expect(src, doc).toMatch(/build-time|build arg/i);
      // The consequence, not just the fact: an operator reading either file
      // must be told that flipping it means a rebuild.
      expect(src, doc).toMatch(/rebuild/i);
    }
  });
});
