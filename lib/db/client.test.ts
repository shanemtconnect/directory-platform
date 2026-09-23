import { describe, it, expect, vi, afterEach } from "vitest";

/**
 * `next build` imports every route module to read its `metadata` and
 * `revalidate` exports. This module is in that import graph, so if it reads
 * DATABASE_URL at import time no page can be built without a database — which
 * is what forced a live DATABASE_URL into the Docker builder stage.
 */
describe("lib/db/client", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("imports without DATABASE_URL", async () => {
    vi.stubEnv("DATABASE_URL", undefined);
    vi.resetModules();
    await expect(import("./client")).resolves.toBeDefined();
  });

  it("still throws the moment anything queries without DATABASE_URL", async () => {
    vi.stubEnv("DATABASE_URL", undefined);
    vi.resetModules();
    const { db, getDb } = await import("./client");
    expect(() => getDb()).toThrow(/DATABASE_URL is not set/);
    expect(() => db.select()).toThrow(/DATABASE_URL is not set/);
  });

  it("opens one pool and reuses it", async () => {
    vi.stubEnv("DATABASE_URL", process.env["DATABASE_URL"] ?? "postgres://directory:directory@localhost:5433/directory_test");
    vi.resetModules();
    const { getDb } = await import("./client");
    expect(getDb()).toBe(getDb());
  });
});
