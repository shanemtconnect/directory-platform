import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Viewer } from "@/lib/db/viewer";
import type { NeighbourhoodCsvRow } from "@/lib/geo/neighbourhoods";
import type { ImportOutcome } from "@/lib/db/queries/neighbourhoods";

/**
 * The three admin actions (Task 52): admin gate first, module gate second,
 * input checked before a transaction opens, the right pages busted after.
 * The query functions are mocked; lib/db/queries/neighbourhoods.test.ts
 * covers what they write.
 */

const requireAdmin = vi.fn<() => Promise<Viewer & { role: "admin" }>>();
const importNeighbourhoods = vi.fn<(rows: readonly NeighbourhoodCsvRow[], opts: { ip?: string | null }) => Promise<ImportOutcome>>();
const setNeighbourhoodPublished = vi.fn<(id: string, published: boolean) => Promise<{ ok: true; citySlug: string; slug: string } | { ok: false }>>();
const enqueueNeighbourhoodAssign = vi.fn<() => Promise<string>>();
const revalidatePath = vi.fn<(p: string) => void>();
const transaction = vi.fn();

vi.mock("next/headers", () => ({ headers: () => Promise.resolve(new Headers({ "x-forwarded-for": "203.0.113.9" })) }));
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => revalidatePath(p) }));
vi.mock("@/lib/db/client", () => ({
  db: {
    transaction: (fn: (tx: unknown) => Promise<unknown>) => {
      transaction();
      return fn({ marker: "tx" });
    },
  },
}));
vi.mock("@/lib/auth/viewer", () => ({ requireAdmin: () => requireAdmin() }));
vi.mock("@/lib/db/queries/neighbourhoods", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/queries/neighbourhoods")>()),
  importNeighbourhoods: (_tx: unknown, _v: unknown, rows: readonly NeighbourhoodCsvRow[], opts: { ip?: string | null }) =>
    importNeighbourhoods(rows, opts),
  setNeighbourhoodPublished: (_tx: unknown, _v: unknown, id: string, published: boolean) =>
    setNeighbourhoodPublished(id, published),
  enqueueNeighbourhoodAssign: () => enqueueNeighbourhoodAssign(),
}));

const form = (fields: Record<string, string | File>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

const IDLE = { status: "idle" as const };
const AREA = "11111111-1111-4111-8111-111111111111";
const CSV = "city_slug,name,slug,lat,lng,radius_km\nleeds,Headingley,headingley,53.82,-1.58,1.5\nleeds,Nowhere,nowhere,95,-1.5,2\n";
const ENV = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  process.env.NEIGHBOURHOODS_ENABLED = "true";
  requireAdmin.mockReset().mockResolvedValue({ role: "admin", userId: "user_admin" });
  importNeighbourhoods.mockReset().mockResolvedValue({ created: 1, updated: 0, skipped: [] });
  setNeighbourhoodPublished.mockReset().mockResolvedValue({ ok: true, citySlug: "leeds", slug: "headingley" });
  enqueueNeighbourhoodAssign.mockReset().mockResolvedValue("job-1");
  revalidatePath.mockReset();
  transaction.mockReset();
});
afterEach(() => {
  process.env = { ...ENV };
});

describe("importNeighbourhoodsAction", () => {
  it("requires an admin before anything else", async () => {
    requireAdmin.mockRejectedValue(new Error("FORBIDDEN"));
    const { importNeighbourhoodsAction } = await import("./admin-neighbourhoods");
    await expect(importNeighbourhoodsAction(IDLE, form({ csv: CSV }))).rejects.toThrow("FORBIDDEN");
    expect(importNeighbourhoods).not.toHaveBeenCalled();
  });

  it("refuses with the module off, without a transaction", async () => {
    process.env.NEIGHBOURHOODS_ENABLED = "false";
    const { importNeighbourhoodsAction } = await import("./admin-neighbourhoods");
    expect((await importNeighbourhoodsAction(IDLE, form({ csv: CSV }))).status).toBe("error");
    expect(transaction).not.toHaveBeenCalled();
  });

  it("refuses a file with the wrong header, without a transaction", async () => {
    const { importNeighbourhoodsAction } = await import("./admin-neighbourhoods");
    const out = await importNeighbourhoodsAction(IDLE, form({ csv: "town,name\nleeds,x\n" }));
    expect(out.status).toBe("error");
    expect(out.message).toMatch(/city_slug,name,slug,lat,lng,radius_km/);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("imports the good rows from an uploaded file and reports the bad ones by line", async () => {
    importNeighbourhoods.mockResolvedValue({ created: 1, updated: 0, skipped: [{ line: 4, message: "taken" }] });
    const { importNeighbourhoodsAction } = await import("./admin-neighbourhoods");
    const file = new File([CSV], "n.csv", { type: "text/csv" });
    const out = await importNeighbourhoodsAction(IDLE, form({ file }));

    expect(importNeighbourhoods).toHaveBeenCalledWith(
      [expect.objectContaining({ slug: "headingley", radiusKm: 1.5 })],
      { ip: "203.0.113.9" },
    );
    expect(out.status).toBe("done");
    expect(out.message).toMatch(/1 created/);
    expect(out.problems?.map((p) => p.line)).toEqual([3, 4]);
    expect(revalidatePath).toHaveBeenCalledWith("/admin/neighbourhoods");
  });
});

describe("setNeighbourhoodPublishedAction", () => {
  it("rejects a malformed id without a transaction, and busts the town and neighbourhood pages on success", async () => {
    const { setNeighbourhoodPublishedAction } = await import("./admin-neighbourhoods");
    expect((await setNeighbourhoodPublishedAction(IDLE, form({ areaId: "nope", published: "false" }))).status).toBe("error");
    expect(transaction).not.toHaveBeenCalled();

    const out = await setNeighbourhoodPublishedAction(IDLE, form({ areaId: AREA, published: "false" }));
    expect(out.status).toBe("done");
    expect(setNeighbourhoodPublished).toHaveBeenCalledWith(AREA, false);
    expect(revalidatePath).toHaveBeenCalledWith("/leeds");
    expect(revalidatePath).toHaveBeenCalledWith("/leeds/headingley");
  });

  it("reports an id that is not a neighbourhood", async () => {
    setNeighbourhoodPublished.mockResolvedValue({ ok: false });
    const { setNeighbourhoodPublishedAction } = await import("./admin-neighbourhoods");
    expect((await setNeighbourhoodPublishedAction(IDLE, form({ areaId: AREA, published: "true" }))).status).toBe("error");
  });
});

describe("assignNeighbourhoodsNowAction", () => {
  it("queues one run for an admin, and refuses with the module off", async () => {
    const { assignNeighbourhoodsNowAction } = await import("./admin-neighbourhoods");
    expect((await assignNeighbourhoodsNowAction(IDLE, form({}))).status).toBe("done");
    expect(enqueueNeighbourhoodAssign).toHaveBeenCalledTimes(1);

    vi.resetModules();
    process.env.NEIGHBOURHOODS_ENABLED = "false";
    const off = await import("./admin-neighbourhoods");
    expect((await off.assignNeighbourhoodsNowAction(IDLE, form({}))).status).toBe("error");
    expect(enqueueNeighbourhoodAssign).toHaveBeenCalledTimes(1);
  });
});
