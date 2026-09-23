import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";
import base from "../../../playwright.config";

/**
 * The screenshot run for docs/screenshots/wave-e.
 *
 * Same server, same database and same environment as the e2e suite — it
 * reuses `playwright.config.ts` wholesale and only points the runner at the
 * capture spec beside this file. Two projects so every screen is shot at a
 * phone width and a desktop width in one run.
 *
 *   SHOT_PHASE=before E2E_PORT=3242 REDIS_URL=redis://localhost:6380/4 \
 *     corepack pnpm exec playwright test --config docs/screenshots/wave-e/capture.config.ts
 */
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const server = base.webServer as Exclude<typeof base.webServer, undefined | unknown[]>;

export default defineConfig({
  ...base,
  // The build runs from the repo root, not from beside this file.
  webServer: { ...server, cwd: ROOT },
  testDir: ".",
  testMatch: "capture.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  projects: [
    { name: "mobile", use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 } },
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } } },
  ],
});
