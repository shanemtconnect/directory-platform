import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * The race suite: tests that COMMIT rows to `directory_test` so two
 * transactions can genuinely be in flight at once (see test/race.ts). One file
 * at a time, one test at a time, and never beside the rolled-back suite.
 *
 * Standalone rather than importing vitest.config.ts (an extensionless import
 * trips Vite's native config loader, a `.ts` one trips tsc), so keep the
 * shared settings below in step with that file.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["**/*.race.test.ts"],
    exclude: ["**/node_modules/**", "**/.next/**", ".claude/worktrees/**", "e2e/**"],
    fileParallelism: false,
    sequence: { concurrent: false },
    // Clears a killed run's leftovers before the suite and sweeps again after.
    globalSetup: ["test/race-global-setup.ts"],
    globals: false,
    env: { NEXT_PUBLIC_DEMO_MODE: "true" },
  },
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
});
