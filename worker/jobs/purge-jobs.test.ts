import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { withTestDb } from "@/test/db";
import { jobQueue } from "@/lib/db/schema";
import { PUBLIC_VIEWER } from "@/lib/db/viewer";
import { ADMIN_VIEWER } from "@/worker/viewer";
import { resetClock, setClock } from "@/lib/clock";
import { completeJob, enqueueJob, failJob, MAX_JOB_ATTEMPTS } from "@/lib/db/queries/jobs";
import type { Db } from "@/lib/db/client";
import { FINISHED_JOB_RETENTION_DAYS, purgeFinishedJobs } from "./purge-jobs";

afterEach(() => resetClock());

describe("purge-jobs", () => {
  it("keeps finished jobs for seven days", () => {
    expect(FINISHED_JOB_RETENTION_DAYS).toBe(7);
  });

  it("deletes done and parked jobs past the window and leaves the rest", async () => {
    await withTestDb(async (tx) => {
      setClock(new Date("2026-03-01T09:00:00Z"));
      const oldDone = await enqueueJob(tx, PUBLIC_VIEWER, { kind: "notify.enquiry", payload: {} });
      await completeJob(tx, ADMIN_VIEWER, oldDone);
      const oldParked = await enqueueJob(tx, PUBLIC_VIEWER, { kind: "notify.enquiry", payload: {} });
      for (let n = 0; n <= MAX_JOB_ATTEMPTS; n++) await failJob(tx, ADMIN_VIEWER, oldParked, "x");
      // Pending for ever is a different problem; a purge must not touch it.
      const oldPending = await enqueueJob(tx, PUBLIC_VIEWER, {
        kind: "notify.enquiry", payload: {}, runAfter: new Date("2026-03-01T09:00:00Z"),
      });

      // Six days and twenty-three hours later: still inside the window.
      setClock(new Date("2026-03-08T08:00:00Z"));
      expect(await purgeFinishedJobs(tx as unknown as Db)).toBe(0);

      // Seven days and an hour: out.
      setClock(new Date("2026-03-08T10:00:00Z"));
      const freshDone = await enqueueJob(tx, PUBLIC_VIEWER, { kind: "notify.enquiry", payload: {} });
      await completeJob(tx, ADMIN_VIEWER, freshDone);
      expect(await purgeFinishedJobs(tx as unknown as Db)).toBe(2);

      const ids = (await tx.select({ id: jobQueue.id }).from(jobQueue)).map((r) => r.id).sort();
      expect(ids).toEqual([oldPending, freshDone].sort());
      expect(await tx.select().from(jobQueue).where(eq(jobQueue.id, oldDone))).toHaveLength(0);
    });
  });
});
