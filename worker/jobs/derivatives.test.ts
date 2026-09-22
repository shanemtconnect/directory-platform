import { describe, it, expect, vi, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { withTestDb, type TestDb } from "@/test/db";
import { listingImages } from "@/lib/db/schema";
import { makeScaffold, makeListing } from "@/test/factories";
import { ADMIN_VIEWER } from "@/worker/viewer";
import { listingPaths } from "@/lib/db/queries/paths";

const getObject = vi.fn<(bucket: string, key: string) => Promise<Buffer>>();
const putObject = vi.fn<() => Promise<void>>();
const deleteObject = vi.fn<() => Promise<void>>();

vi.mock("@/lib/media/r2", () => ({
  getObject: (bucket: string, key: string) => getObject(bucket, key),
  putObject: () => putObject(),
  deleteObject: () => deleteObject(),
}));

const { processPendingDerivatives, derivativesJob, MAX_DERIVATIVE_ATTEMPTS } =
  await import("./derivatives");

const realPng = await sharp({
  create: { width: 8, height: 8, channels: 3, background: { r: 10, g: 20, b: 30 } },
}).png().toBuffer();

beforeEach(() => {
  process.env.R2_BUCKET_MEDIA = "media";
  getObject.mockReset();
  putObject.mockReset().mockResolvedValue(undefined);
  deleteObject.mockReset().mockResolvedValue(undefined);
});

async function makeImage(tx: TestDb, patch: Partial<typeof listingImages.$inferInsert> = {}) {
  const ctx = await makeScaffold(tx);
  const listingId = await makeListing(tx, ctx);
  const [row] = await tx.insert(listingImages).values({
    listingId, storagePath: `${listingId}/original.jpg`, ...patch,
  }).returning({ id: listingImages.id });
  return row!.id;
}

describe("processPendingDerivatives", () => {
  it("writes the four sizes and marks the row done", async () => {
    await withTestDb(async (tx) => {
      const id = await makeImage(tx);
      getObject.mockResolvedValue(realPng);

      expect(await processPendingDerivatives(tx)).toBe(1);
      const [row] = await tx.select().from(listingImages).where(eq(listingImages.id, id));
      expect(Object.keys(row?.derivatives as object).sort())
        .toEqual(["card", "full", "hero", "thumb"]);
      expect(row?.derivativesError).toBeNull();
    });
  });

  /**
   * The object store is not a trusted source. An SVG or an HTML page renamed
   * to .jpg reaches the worker as bytes, and sharp will happily rasterise an
   * SVG — which is how a stored-XSS payload becomes a listing photo.
   */
  it("rejects an upload whose magic bytes are not an allowed image", async () => {
    await withTestDb(async (tx) => {
      const id = await makeImage(tx);
      getObject.mockResolvedValue(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'));

      expect(await processPendingDerivatives(tx)).toBe(0);
      const [row] = await tx.select().from(listingImages).where(eq(listingImages.id, id));
      expect(row?.derivatives).toBeNull();
      expect(row?.derivativesError).toMatch(/Unrecognised file type/);
    });
  });

  it("deletes the rejected object rather than leaving it in the bucket", async () => {
    await withTestDb(async (tx) => {
      await makeImage(tx);
      getObject.mockResolvedValue(Buffer.from("not an image at all"));

      await processPendingDerivatives(tx);
      expect(deleteObject).toHaveBeenCalledTimes(1);
      expect(putObject).not.toHaveBeenCalled();
    });
  });

  it("never retries a rejected upload — the bytes will not improve", async () => {
    await withTestDb(async (tx) => {
      const id = await makeImage(tx);
      getObject.mockResolvedValue(Buffer.from("not an image at all"));
      await processPendingDerivatives(tx);

      getObject.mockClear();
      await processPendingDerivatives(tx);
      expect(getObject).not.toHaveBeenCalled();

      const [row] = await tx.select().from(listingImages).where(eq(listingImages.id, id));
      expect(row?.derivativesAttempts).toBe(MAX_DERIVATIVE_ATTEMPTS);
    });
  });

  it("counts a transient failure and records why", async () => {
    await withTestDb(async (tx) => {
      const id = await makeImage(tx);
      getObject.mockRejectedValue(new Error("R2 timed out"));

      expect(await processPendingDerivatives(tx)).toBe(0);
      const [row] = await tx.select().from(listingImages).where(eq(listingImages.id, id));
      expect(row?.derivativesAttempts).toBe(1);
      expect(row?.derivativesError).toBe("R2 timed out");
    });
  });

  /**
   * The job ran every minute against every row with no derivatives, so one
   * image that could not be processed cost an R2 GET and a sharp decode every
   * minute for ever.
   */
  it("gives up after the attempt cap instead of retrying for ever", async () => {
    await withTestDb(async (tx) => {
      await makeImage(tx, { derivativesAttempts: MAX_DERIVATIVE_ATTEMPTS });
      getObject.mockResolvedValue(realPng);

      expect(await processPendingDerivatives(tx)).toBe(0);
      expect(getObject).not.toHaveBeenCalled();
    });
  });

  it("still picks up a row one attempt short of the cap", async () => {
    await withTestDb(async (tx) => {
      const id = await makeImage(tx, {
        derivativesAttempts: MAX_DERIVATIVE_ATTEMPTS - 1,
        derivativesError: "R2 timed out",
      });
      getObject.mockResolvedValue(realPng);

      expect(await processPendingDerivatives(tx)).toBe(1);
      const [row] = await tx.select().from(listingImages).where(eq(listingImages.id, id));
      expect(row?.derivativesError).toBeNull();
    });
  });

  it("leaves a row that already has derivatives alone", async () => {
    await withTestDb(async (tx) => {
      await makeImage(tx, { derivatives: { thumb: "a", card: "b", hero: "c", full: "d" } });
      expect(await processPendingDerivatives(tx)).toBe(0);
      expect(getObject).not.toHaveBeenCalled();
    });
  });

  /**
   * The public gallery sets width and height on every <img> so the page does
   * not shift as the photos load. The worker is the only thing that has seen
   * the decoded, rotated image, so it records the size of the largest
   * derivative — after the EXIF orientation has been applied, which is why a
   * portrait phone photo comes out taller than it is wide.
   */
  it("records the largest derivative's dimensions on the row", async () => {
    await withTestDb(async (tx) => {
      const id = await makeImage(tx);
      const wide = await sharp({
        create: { width: 3000, height: 1500, channels: 3, background: { r: 1, g: 2, b: 3 } },
      }).png().toBuffer();
      getObject.mockResolvedValue(wide);

      expect(await processPendingDerivatives(tx)).toBe(1);
      const [row] = await tx.select().from(listingImages).where(eq(listingImages.id, id));
      // `full` is capped at 2000 wide and never enlarged.
      expect(row?.width).toBe(2000);
      expect(row?.height).toBe(1000);
    });
  });

  it("hands back the paths of every listing whose photo just went live", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const listingId = await makeListing(tx, ctx);
      await tx.insert(listingImages).values([
        { listingId, storagePath: `listings/${listingId}/photo-0000000000000001.jpg` },
        { listingId, storagePath: `listings/${listingId}/photo-0000000000000002.jpg` },
      ]);
      getObject.mockResolvedValue(realPng);

      const outcome = await derivativesJob(tx);
      // Once per listing, not once per image.
      expect(outcome.revalidate).toEqual(await listingPaths(tx, ADMIN_VIEWER, listingId));
    });
  });

  it("hands back nothing when no image went live", async () => {
    await withTestDb(async (tx) => {
      await makeImage(tx);
      getObject.mockResolvedValue(Buffer.from("not an image at all"));
      expect((await derivativesJob(tx)).revalidate).toEqual([]);
    });
  });
});
