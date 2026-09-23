import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withTestDb } from "@/test/db";
import { jobs } from "@/lib/db/schema";
import { makeScaffold } from "@/test/factories";
import { now, resetClock, setClock } from "@/lib/clock";
import { PUBLIC_VIEWER } from "@/lib/db/viewer";

/**
 * The jobs shard (Task 49), in its own file so the shared sitemap test is
 * untouched. The flag is a build-time constant read at module load, so it is
 * mocked before the import rather than flipped per test.
 */
vi.mock("@/lib/features/flags", () => ({ features: { jobBoard: true } }));

const { JOBS_SHARD_ID, sitemapJobs, sitemapShardIds } = await import("./sitemap");

afterEach(() => resetClock());

describe("jobs sitemap shard", () => {
  it("is advertised last when the flag is on", () => {
    const ids = sitemapShardIds(0);
    expect(ids[ids.length - 1]).toBe(JOBS_SHARD_ID);
  });

  it("lists open jobs and their filter pages once each, never a closed one", async () => {
    await withTestDb(async (tx) => {
      setClock(new Date("2026-09-22T10:00:00Z"));
      const ctx = await makeScaffold(tx);
      const open = randomUUID();
      const base = {
        title: "T",
        cityId: ctx.cityId,
        categoryId: ctx.primaryCategoryId,
        publishedAt: now(),
        expiresAt: new Date(now().getTime() + 86_400_000),
      };
      await tx.insert(jobs).values([
        { ...base, id: open, status: "published" },
        { ...base, id: randomUUID(), status: "published" },
        { ...base, id: randomUUID(), status: "expired" },
        { ...base, id: randomUUID(), status: "published", expiresAt: new Date("2026-09-01T00:00:00Z") },
        { ...base, id: randomUUID(), status: "pending" },
      ]);

      const paths = (await sitemapJobs(tx, PUBLIC_VIEWER)).map((e) => e.path);
      expect(paths).toContain(`/jobs/${open}`);
      expect(paths.filter((p) => p === "/jobs/in/leeds")).toHaveLength(1);
      expect(paths).toContain("/jobs/in/leeds/barn-venues");
      expect(paths).toContain("/jobs/category/barn-venues");
      // Two open jobs, two filter-page sets deduplicated: 2 + 3.
      expect(paths.filter((p) => /^\/jobs\/[0-9a-f-]{36}$/.test(p))).toHaveLength(2);
      expect(paths).toHaveLength(5);
    });
  });
});
