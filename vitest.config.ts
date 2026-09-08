import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: { environment: "node", include: ["**/*.test.ts"],
    // Agent worktrees are full copies of this repo. Without this, vitest runs
    // every test several times over and the counts are meaningless.
    exclude: ["**/node_modules/**", "**/.next/**", ".claude/worktrees/**", "e2e/**"],
    globals: false },
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
});
