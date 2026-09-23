import { defineConfig, devices } from "@playwright/test";
import { E2E_DATABASE_URL } from "./e2e/database";

/**
 * E2E smoke suite.
 *
 * Runs against a production build, not `next dev`: the things these tests
 * protect — ISR-cached pillar pages, server-rendered pagination anchors, the
 * JSON-LD that ships in the HTML — only behave like production in a production
 * build. `next dev` would give false confidence.
 */
/**
 * 3200 by default. `E2E_PORT` exists because this repo is worked on by several
 * agents at once and `reuseExistingServer` will happily hand the suite whatever
 * is already listening on the port — which is another worktree's build, quietly
 * testing somebody else's code. Overriding the port is how you get a run that
 * is definitely yours.
 */
const PORT = Number(process.env.E2E_PORT ?? 3200);
const BASE_URL = `http://localhost:${PORT}`;

/**
 * The build is `output: 'standalone'`, so `next start` is the wrong server: it
 * prints "next start does not work with output: standalone" and runs a
 * different process from the one that ships in the image. These tests now run
 * the same `server.js` the Dockerfile runs, assembled the same way — the
 * standalone bundle does not include `.next/static` or `public`, which have to
 * be copied in beside it (see the Dockerfile's COPY lines). `public` is
 * optional and does not exist in this repo yet.
 */
const START_STANDALONE = [
  "corepack pnpm build",
  "rm -rf .next/standalone/.next/static .next/standalone/public",
  "cp -R .next/static .next/standalone/.next/static",
  "if [ -d public ]; then cp -R public .next/standalone/public; fi",
  "node .next/standalone/server.js",
].join(" && ");

/**
 * Defaults are the local dev stack from docker-compose.dev.yml, seeded with
 * 50 cities, 20 categories and 200 listings — but its own database, NOT
 * `directory_dev`. This suite writes: e2e/location.spec.ts submits a listing
 * through the real form and creates a city with it. `bash scripts/e2e-db.sh`
 * (`corepack pnpm test:e2e:db`) builds `directory_e2e`; DATABASE_URL still
 * overrides, and CI supplies its own values.
 * NEXT_PUBLIC_SITE_URL is pinned to the test origin either way, because the
 * sitemap test asserts on the absolute URLs it produces.
 *
 * SITE_FLAGS_OVERRIDE is passed through rather than pinned: CI runs this suite
 * twice, once with every optional flag off and once with all of them on, and
 * the flags are build-time constants, so the override has to reach the build.
 * HOSTNAME is pinned because the standalone server binds to it and a login
 * shell that exports its own would bind somewhere unreachable.
 */
const SERVER_ENV: Record<string, string> = {
  DATABASE_URL: E2E_DATABASE_URL,
  REDIS_URL: process.env.REDIS_URL ?? "redis://localhost:6380",
  NEXT_PUBLIC_SITE_URL: BASE_URL,
  /**
   * `siteEnv()` treats anything that is not the literal "production" as
   * staging, so an unset SITE_ENV would serve `Disallow: /` and an empty
   * sitemap — and e2e/sitemap.spec.ts asserts the production shape of both.
   * Pinned rather than passed through for the same reason NEXT_PUBLIC_SITE_URL
   * is: this suite tests what a live site does. It reaches the BUILD as well as
   * the server, which it has to — the X-Robots-Tag header is frozen into
   * routes-manifest.json by `next build`.
   */
  SITE_ENV: process.env.SITE_ENV ?? "production",
  /**
   * Better Auth's own per-process limiter caps sign-ups at 3 per 10 s per
   * address, and every worker here is 127.0.0.1. Off for this server only —
   * see the comment on `rateLimit` in lib/auth/server.ts. The Redis limiter in
   * app/api/auth/[...all]/route.ts is untouched.
   */
  BETTER_AUTH_RATE_LIMIT: "off",
  /**
   * Cloudflare's published testing keys: the widget always passes and
   * siteverify always accepts. They are needed because this suite runs a
   * production build, and in production a missing secret now fails closed
   * rather than skipping (lib/spam/turnstile.ts). Without them the enquiry
   * form could not be exercised at all.
   */
  TURNSTILE_SITE_KEY: process.env.TURNSTILE_SITE_KEY ?? "1x00000000000000000000AA",
  TURNSTILE_SECRET_KEY:
    process.env.TURNSTILE_SECRET_KEY ?? "1x0000000000000000000000000000000AA",
  // Keeps the blog fixtures loadable; production clones ship without them.
  NEXT_PUBLIC_DEMO_MODE: "true",
  /**
   * Required at boot now that auth is wired (RUNTIME_ENV in config/validate.ts),
   * so the standalone server exits 1 without them. Throwaway values: this suite
   * signs nobody in, and a secret that is obviously not a secret is safer in a
   * config file than one that looks like it might be real.
   */
  BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET ?? "e2e-not-a-real-secret",
  BETTER_AUTH_URL: process.env.BETTER_AUTH_URL ?? BASE_URL,
  /**
   * Owner photos (e2e/photos.spec.ts). The presign step signs a POST policy
   * offline — no request leaves the box — so throwaway R2 credentials are
   * enough for the upload form to exist, and the spec intercepts the
   * browser's POST to the bucket host. Only the MEDIA bucket is named:
   * R2_BUCKET_CLAIM_DOCS stays unset, so claim documents remain "not
   * configured" and claim.spec.ts sees the page it always did. The media URL
   * is BUILD-time (NEXT_PUBLIC_, inlined) and is what turns a processed
   * photo into an <img> on the listing page; the host is reserved and never
   * fetched, the spec asserts on the attributes.
   */
  R2_ACCOUNT_ID: process.env.R2_ACCOUNT_ID ?? "e2e-account",
  R2_ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID ?? "e2e-not-a-real-key",
  R2_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY ?? "e2e-not-a-real-secret",
  R2_BUCKET_MEDIA: process.env.R2_BUCKET_MEDIA ?? "e2e-media",
  NEXT_PUBLIC_MEDIA_URL: process.env.NEXT_PUBLIC_MEDIA_URL ?? "https://media.e2e.invalid",
  PORT: String(PORT),
  HOSTNAME: "127.0.0.1",
  ...(process.env.SITE_FLAGS_OVERRIDE
    ? { SITE_FLAGS_OVERRIDE: process.env.SITE_FLAGS_OVERRIDE }
    : {}),
  // Sponsor rails (Task 43): the template config has them off; e2e/sponsors.spec.ts
  // runs with ADS_ENABLED=true to prove the production shape.
  ...(process.env.ADS_ENABLED ? { ADS_ENABLED: process.env.ADS_ENABLED } : {}),
};

// Specs run in this process, not the server's, so the one server setting a
// spec has to know about is mirrored here: whether the demo blog posts exist.
process.env.E2E_DEMO_MODE = SERVER_ENV.NEXT_PUBLIC_DEMO_MODE;
process.env.E2E_MEDIA_URL = SERVER_ENV.NEXT_PUBLIC_MEDIA_URL;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],

  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },

  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],

  webServer: {
    command: START_STANDALONE,
    url: BASE_URL,
    // A cold Next build plus first-request ISR renders; generous on purpose.
    timeout: 10 * 60 * 1000,
    reuseExistingServer: !process.env.CI,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...SERVER_ENV } as Record<string, string>,
  },
});
