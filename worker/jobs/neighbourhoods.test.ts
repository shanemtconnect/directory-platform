import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { jobQueue, listings } from "@/lib/db/schema";
import { withTestDb, type TestDb } from "@/test/db";
import { makeViewer } from "@/test/admin-fixtures";
import { makeListing, makeNeighbourhood, makeScaffold } from "@/test/factories";
import { enqueueNeighbourhoodAssign } from "@/lib/db/queries/neighbourhoods";
import type { Db } from "@/lib/db/client";
import { drainNeighbourhoodQueue, runNeighbourhoodAssign, NEIGHBOURHOODS_CRON } from "./neighbourhoods";

const CENTRE = { lat: 53.8, lng: -1.55 };

async function scenario(tx: TestDb) {
  const ctx = await makeScaffold(tx);
  const areaId = await makeNeighbourhood(tx, ctx.cityId, "Headingley", { ...CENTRE, radiusKm: 2 });
  const listingId = await makeListing(tx, ctx, { name: "Inside", ...CENTRE });
  return { areaId, listingId };
}

async function areaOf(tx: TestDb, id: string) {
  const [l] = await tx.select({ areaId: listings.areaId }).from(listings).where(eq(listings.id, id));
  return l!.areaId;
}

describe("neighbourhoods.assign (worker)", () => {
  it("runs nightly", () => {
    expect(NEIGHBOURHOODS_CRON.split(" ")).toHaveLength(5);
    expect(NEIGHBOURHOODS_CRON.split(" ").slice(2)).toEqual(["*", "*", "*"]);
  });

  it("is a no-op with the module off", async () => {
    await withTestDb(async (tx) => {
      const { listingId } = await scenario(tx);
      expect(await runNeighbourhoodAssign(tx as unknown as Db, false)).toEqual({ revalidate: [] });
      expect(await areaOf(tx, listingId)).toBeNull();
    });
  });

  it("assigns every town and hands back the pages it left stale", async () => {
    await withTestDb(async (tx) => {
      const { areaId, listingId } = await scenario(tx);
      const out = await runNeighbourhoodAssign(tx as unknown as Db, true);
      expect(await areaOf(tx, listingId)).toBe(areaId);
      expect(out.revalidate.some((p) => p.endsWith("/headingley"))).toBe(true);
    });
  });

  it("drains the admin's queued 'assign now' into one run and completes the job", async () => {
    await withTestDb(async (tx) => {
      const admin = await makeViewer(tx);
      const { areaId, listingId } = await scenario(tx);
      const a = await enqueueNeighbourhoodAssign(tx, admin, { ip: null });
      const b = await enqueueNeighbourhoodAssign(tx, admin, { ip: null });

      await drainNeighbourhoodQueue(tx as unknown as Db, true);

      expect(await areaOf(tx, listingId)).toBe(areaId);
      const jobs = await tx.select({ id: jobQueue.id, status: jobQueue.status }).from(jobQueue);
      expect(jobs.filter((j) => j.id === a || j.id === b).map((j) => j.status)).toEqual(["done", "done"]);
    });
  });

  it("leaves a queued job pending with the module off", async () => {
    await withTestDb(async (tx) => {
      const admin = await makeViewer(tx);
      await scenario(tx);
      const id = await enqueueNeighbourhoodAssign(tx, admin, { ip: null });
      await drainNeighbourhoodQueue(tx as unknown as Db, false);
      const [job] = await tx.select({ status: jobQueue.status }).from(jobQueue).where(eq(jobQueue.id, id));
      expect(job!.status).toBe("pending");
    });
  });
});
