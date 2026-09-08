import { defineConfig, devices } from "@playwright/test";

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
 * 50 cities, 20 categories and 200 listings. CI supplies its own values.
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
  DATABASE_URL:
    process.env.DATABASE_URL ?? "postgres://directory:directory@localhost:5433/directory_dev",
  REDIS_URL: process.env.REDIS_URL ?? "redis://localhost:6380",
  NEXT_PUBLIC_SITE_URL: BASE_URL,
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
  PORT: String(PORT),
  HOSTNAME: "127.0.0.1",
  ...(process.env.SITE_FLAGS_OVERRIDE
    ? { SITE_FLAGS_OVERRIDE: process.env.SITE_FLAGS_OVERRIDE }
    : {}),
};

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
