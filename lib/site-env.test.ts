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
  it("defaults to production when unset — staging must be opted into", () => {
    delete process.env.SITE_ENV;
    expect(siteEnv()).toBe("production");
    expect(isStaging()).toBe(false);
  });

  it("is staging only for the exact string 'staging'", () => {
    process.env.SITE_ENV = "staging";
    expect(isStaging()).toBe(true);
    for (const v of ["Staging", "stage", "STAGING", "true", "1", ""]) {
      process.env.SITE_ENV = v;
      expect(isStaging()).toBe(false);
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
    expect(src).toContain('process.env.SITE_ENV !== "staging"');
  });
});
