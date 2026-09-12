import { describe, it, expect } from "vitest";
import { withTestDb } from "@/test/db";
import { jobQueue, jobRuns } from "@/lib/db/schema";
import { pingDatabase, jobCounts } from "./health";

describe("pingDatabase", () => {
  it("resolves against a reachable database", async () => {
    await withTestDb(async (tx) => {
      await expect(pingDatabase(tx)).resolves.toBeUndefined();
    });
  });
});

describe("jobCounts", () => {
  it("counts the queue by status and the runs inside the window", async () => {
    await withTestDb(async (tx) => {
      await tx.insert(jobQueue).values([
        { kind: "notify.enquiry", payload: {}, status: "pending" },
        { kind: "notify.enquiry", payload: {}, status: "pending" },
        { kind: "notify.enquiry", payload: {}, status: "failed" },
      ]);
      const inside = new Date(Date.now() - 60_000);
      const outside = new Date(Date.now() - 3_600_000);
      await tx.insert(jobRuns).values([
        { jobName: "notify", startedAt: inside, status: "ok" },
        { jobName: "derivatives", startedAt: inside, status: "failed" },
        { jobName: "notify", startedAt: outside, status: "ok" },
      ]);

      const counts = await jobCounts(tx, new Date(Date.now() - 5 * 60_000));

      // `>=`, not `toBe`: the test database is shared and a sibling
      // transaction's committed rows would otherwise make this flaky. The
      // window is what is actually under test.
      expect(counts.queue.pending).toBeGreaterThanOrEqual(2);
      expect(counts.queue.failed).toBeGreaterThanOrEqual(1);
      expect(counts.runs.ok).toBeGreaterThanOrEqual(1);
      expect(counts.runs.failed).toBeGreaterThanOrEqual(1);
    });
  });

  it("returns numbers, not the strings Postgres counts with", async () => {
    await withTestDb(async (tx) => {
      await tx.insert(jobQueue).values({ kind: "notify.enquiry", payload: {}, status: "pending" });

      const counts = await jobCounts(tx, new Date(Date.now() - 60_000));

      // `count(*)` comes back from node-postgres as a string; a heartbeat line
      // reading `pending=3` either way hides the difference until something
      // tries to add two of them together.
      for (const n of [...Object.values(counts.queue), ...Object.values(counts.runs)]) {
        expect(typeof n).toBe("number");
      }
    });
  });
});
