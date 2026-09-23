import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    environment: "node",
    include: ["**/*.test.ts"],
    // Agent worktrees are full copies of this repo. Without this, vitest runs
    // every test several times over and the counts are meaningless.
    exclude: ["**/node_modules/**", "**/.next/**", ".claude/worktrees/**", "e2e/**"],
    globals: false,
    // The demo posts under `content/blog/demo/` are the blog fixtures the suite
    // asserts against, and `lib/blog/demo.ts` only loads them when this flag is
    // exactly "true". Setting it here makes the blog tests deterministic
    // regardless of the developer's shell; tests that need the flag off stub it.
    env: { NEXT_PUBLIC_DEMO_MODE: "true" },
  },
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
});
