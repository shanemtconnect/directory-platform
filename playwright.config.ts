import { defineConfig, devices } from "@playwright/test";

/**
 * E2E smoke suite.
 *
 * Runs against a production build, not `next dev`: the things these tests
 * protect — ISR-cached pillar pages, server-rendered pagination anchors, the
 * JSON-LD that ships in the HTML — only behave like production in a production
 * build. `next dev` would give false confidence.
 */
const PORT = 3200;
const BASE_URL = `http://localhost:${PORT}`;

/**
 * Defaults are the local dev stack from docker-compose.dev.yml, seeded with
 * 50 cities, 20 categories and 200 listings. CI supplies its own values.
 * NEXT_PUBLIC_SITE_URL is pinned to the test origin either way, because the
 * sitemap test asserts on the absolute URLs it produces.
 */
const SERVER_ENV = {
  DATABASE_URL:
    process.env.DATABASE_URL ?? "postgres://directory:directory@localhost:5433/directory_dev",
  REDIS_URL: process.env.REDIS_URL ?? "redis://localhost:6380",
  NEXT_PUBLIC_SITE_URL: BASE_URL,
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
    command: "corepack pnpm build && corepack pnpm start -p 3200",
    url: BASE_URL,
    // A cold Next build plus first-request ISR renders; generous on purpose.
    timeout: 10 * 60 * 1000,
    reuseExistingServer: !process.env.CI,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...SERVER_ENV } as Record<string, string>,
  },
});
