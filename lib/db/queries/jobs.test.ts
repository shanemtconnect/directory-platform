import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { withTestDb, type TestDb } from "@/test/db";
import { jobQueue } from "@/lib/db/schema";
import { PUBLIC_VIEWER, type Viewer } from "@/lib/db/viewer";
import { ADMIN_VIEWER } from "@/worker/viewer";
import { setClock, resetClock, now } from "@/lib/clock";
import {
  enqueueJob,
  claimNextJob,
  completeJob,
  failJob,
  purgeFinishedJobs,
  scrubPayload,
  MAX_JOB_ATTEMPTS,
} from "./jobs";

const KINDS = ["notify.enquiry"];
const USER: Viewer = { role: "user", userId: "00000000-0000-4000-8000-00000000use1" };

async function row(tx: TestDb, id: string) {
  const [r] = await tx.select().from(jobQueue).where(eq(jobQueue.id, id)).limit(1);
  return r!;
}

describe("the jobs queue", () => {
  it("enqueues, claims, and completes a job", async () => {
    await withTestDb(async (tx) => {
      const id = await enqueueJob(tx, PUBLIC_VIEWER, {
        kind: "notify.enquiry",
        payload: { enquiryId: "abc" },
      });

      const claimed = await claimNextJob(tx, ADMIN_VIEWER, KINDS);
      expect(claimed).toMatchObject({
        id,
        kind: "notify.enquiry",
        payload: { enquiryId: "abc" },
        attempts: 0,
      });

      await completeJob(tx, ADMIN_VIEWER, id);
      const after = await row(tx, id);
      expect(after.status).toBe("done");
      expect(after.finishedAt).not.toBeNull();

      expect(await claimNextJob(tx, ADMIN_VIEWER, KINDS)).toBeNull();
    });
  });

  it("claims the job that has been waiting longest", async () => {
    await withTestDb(async (tx) => {
      const base = new Date("2026-01-01T09:00:00Z");
      const second = await enqueueJob(tx, PUBLIC_VIEWER, {
        kind: "notify.enquiry", payload: {}, runAfter: new Date(base.getTime() + 60_000),
      });
      const first = await enqueueJob(tx, PUBLIC_VIEWER, {
        kind: "notify.enquiry", payload: {}, runAfter: base,
      });

      expect((await claimNextJob(tx, ADMIN_VIEWER, KINDS))?.id).toBe(first);
      await completeJob(tx, ADMIN_VIEWER, first);
      expect((await claimNextJob(tx, ADMIN_VIEWER, KINDS))?.id).toBe(second);
    });
  });

  it("leaves a job alone until its runAfter has passed", async () => {
    await withTestDb(async (tx) => {
      await enqueueJob(tx, PUBLIC_VIEWER, {
        kind: "notify.enquiry",
        payload: {},
        runAfter: new Date(Date.now() + 3_600_000),
      });
      expect(await claimNextJob(tx, ADMIN_VIEWER, KINDS)).toBeNull();
    });
  });

  it("ignores kinds this worker does not handle", async () => {
    await withTestDb(async (tx) => {
      await enqueueJob(tx, PUBLIC_VIEWER, { kind: "notify.something-else", payload: {} });
      expect(await claimNextJob(tx, ADMIN_VIEWER, KINDS)).toBeNull();
    });
  });

  it("increments attempts, records the error and backs the job off", async () => {
    await withTestDb(async (tx) => {
      try {
        setClock(new Date("2026-01-01T09:00:00Z"));
        const id = await enqueueJob(tx, PUBLIC_VIEWER, { kind: "notify.enquiry", payload: {} });
        await claimNextJob(tx, ADMIN_VIEWER, KINDS);

        const outcome = await failJob(tx, ADMIN_VIEWER, id, "provider timed out");
        expect(outcome).toEqual({ status: "pending", attempts: 1 });

        const after = await row(tx, id);
        expect(after.lastError).toBe("provider timed out");
        expect(after.status).toBe("pending");
        expect(after.runAfter.getTime()).toBeGreaterThan(now().getTime());
      } finally {
        resetClock();
      }
    });
  });

  it("parks the job on the failure after the last retry, and stops claiming it", async () => {
    await withTestDb(async (tx) => {
      const id = await enqueueJob(tx, PUBLIC_VIEWER, { kind: "notify.enquiry", payload: {} });

      for (let attempt = 1; attempt <= MAX_JOB_ATTEMPTS; attempt++) {
        expect(await failJob(tx, ADMIN_VIEWER, id, `attempt ${attempt}`)).toEqual({
          status: "pending",
          attempts: attempt,
        });
      }

      expect(await failJob(tx, ADMIN_VIEWER, id, "final")).toEqual({
        status: "failed",
        attempts: MAX_JOB_ATTEMPTS + 1,
      });

      const parked = await row(tx, id);
      expect(parked.status).toBe("failed");
      expect(parked.lastError).toBe("final");
      expect(parked.finishedAt).not.toBeNull();

      // Nothing may pick a parked job back up, whatever its runAfter says.
      await tx.update(jobQueue).set({ runAfter: new Date(0) }).where(eq(jobQueue.id, id));
      expect(await claimNextJob(tx, ADMIN_VIEWER, KINDS)).toBeNull();
    });
  });

  it("refuses to hand the queue to anyone but the worker", async () => {
    await withTestDb(async (tx) => {
      const id = await enqueueJob(tx, PUBLIC_VIEWER, { kind: "notify.enquiry", payload: {} });
      await expect(claimNextJob(tx, USER, KINDS)).rejects.toThrow(/FORBIDDEN/);
      await expect(completeJob(tx, PUBLIC_VIEWER, id)).rejects.toThrow(/FORBIDDEN/);
      await expect(failJob(tx, USER, id, "x")).rejects.toThrow(/FORBIDDEN/);
    });
  });

  describe("payload scrubbing", () => {
    it("keeps ids and drops everything else", () => {
      expect(scrubPayload({ claimId: "c1", token: "SECRET", url: "https://x/?t=SECRET" }))
        .toEqual({ claimId: "c1" });
      expect(scrubPayload({ reviewId: "r1", token: "SECRET" })).toEqual({ reviewId: "r1" });
      expect(scrubPayload({ userId: "u1", token: "SECRET" })).toEqual({ userId: "u1" });
      expect(scrubPayload({ listingId: "l1", decision: "approved" })).toEqual({ listingId: "l1" });
      expect(scrubPayload({ token: "SECRET" })).toEqual({});
    });

    it("keeps only string ids — a nested object under an id key is not an id", () => {
      expect(scrubPayload({ claimId: { token: "SECRET" }, reviewId: 7 })).toEqual({});
    });

    it("strips the payload to ids when a job completes", async () => {
      await withTestDb(async (tx) => {
        const id = await enqueueJob(tx, PUBLIC_VIEWER, {
          kind: "notify.enquiry",
          payload: { claimId: "c1", token: "SECRET-TOKEN" },
        });
        await claimNextJob(tx, ADMIN_VIEWER, KINDS);
        await completeJob(tx, ADMIN_VIEWER, id);

        const after = await row(tx, id);
        expect(after.payload).toEqual({ claimId: "c1" });
        expect(JSON.stringify(after.payload)).not.toContain("SECRET");
      });
    });

    it("keeps the payload intact while the job can still be retried", async () => {
      await withTestDb(async (tx) => {
        const id = await enqueueJob(tx, PUBLIC_VIEWER, {
          kind: "notify.enquiry",
          payload: { claimId: "c1", token: "SECRET-TOKEN" },
        });
        expect(await failJob(tx, ADMIN_VIEWER, id, "provider timed out")).toMatchObject({
          status: "pending",
        });
        // The retry needs the token: a scrubbed pending job could never send.
        expect((await row(tx, id)).payload).toEqual({ claimId: "c1", token: "SECRET-TOKEN" });
      });
    });

    it("strips the payload to ids when a job is parked for good", async () => {
      await withTestDb(async (tx) => {
        const id = await enqueueJob(tx, PUBLIC_VIEWER, {
          kind: "notify.enquiry",
          payload: { reviewId: "r1", token: "SECRET-TOKEN" },
        });
        for (let attempt = 1; attempt <= MAX_JOB_ATTEMPTS; attempt++) {
          await failJob(tx, ADMIN_VIEWER, id, `attempt ${attempt}`);
        }
        expect(await failJob(tx, ADMIN_VIEWER, id, "final")).toMatchObject({ status: "failed" });

        const parked = await row(tx, id);
        expect(parked.payload).toEqual({ reviewId: "r1" });
      });
    });
  });

  describe("purgeFinishedJobs", () => {
    it("deletes done and failed jobs older than the cutoff and nothing else", async () => {
      await withTestDb(async (tx) => {
        try {
          setClock(new Date("2026-03-01T09:00:00Z"));
          const oldDone = await enqueueJob(tx, PUBLIC_VIEWER, { kind: "notify.enquiry", payload: {} });
          await completeJob(tx, ADMIN_VIEWER, oldDone);
          const oldFailed = await enqueueJob(tx, PUBLIC_VIEWER, { kind: "notify.enquiry", payload: {} });
          for (let attempt = 0; attempt <= MAX_JOB_ATTEMPTS; attempt++) {
            await failJob(tx, ADMIN_VIEWER, oldFailed, "x");
          }
          const oldPending = await enqueueJob(tx, PUBLIC_VIEWER, {
            kind: "notify.enquiry", payload: {}, runAfter: new Date("2026-03-01T09:00:00Z"),
          });

          setClock(new Date("2026-03-10T09:00:00Z"));
          const freshDone = await enqueueJob(tx, PUBLIC_VIEWER, { kind: "notify.enquiry", payload: {} });
          await completeJob(tx, ADMIN_VIEWER, freshDone);

          const cutoff = new Date("2026-03-03T09:00:00Z");
          expect(await purgeFinishedJobs(tx, ADMIN_VIEWER, cutoff)).toBe(2);

          const remaining = await tx.select({ id: jobQueue.id }).from(jobQueue);
          const ids = remaining.map((r) => r.id).sort();
          expect(ids).toEqual([oldPending, freshDone].sort());
        } finally {
          resetClock();
        }
      });
    });

    it("is the worker's to run", async () => {
      await withTestDb(async (tx) => {
        await expect(purgeFinishedJobs(tx, USER, new Date())).rejects.toThrow(/FORBIDDEN/);
      });
    });
  });
});
