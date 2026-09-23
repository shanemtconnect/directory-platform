import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Viewer } from "@/lib/db/viewer";
import type { AdminSpotResult } from "@/lib/db/queries/spots";

/**
 * The admin's three buttons re-check the admin, carry the request ip into
 * the audit row, and bust the pages the spot sits on.
 */
const requireAdmin = vi.fn<() => Promise<Viewer>>();
const closeSpot = vi.fn<(...a: unknown[]) => Promise<AdminSpotResult>>();
const openSpot = vi.fn<(...a: unknown[]) => Promise<AdminSpotResult>>();
const setSpotFloor = vi.fn<(...a: unknown[]) => Promise<AdminSpotResult>>();
const settleSpots = vi.fn<(...a: unknown[]) => Promise<{ paths: string[]; listingIds: string[]; changes: [] }>>();
const revalidatePath = vi.fn<(p: string) => void>();
const revalidateListingPaths = vi.fn<(p: readonly string[]) => void>();
const HANDLE = { marker: "tx" };
const KEY = "city:11111111-1111-4111-8111-111111111111:-";
const SPOT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DONE: AdminSpotResult = { outcome: "done", spotId: SPOT, listingIds: ["l1"], paths: ["/leeds"] };

vi.mock("next/headers", () => ({ headers: () => Promise.resolve(new Headers({ "x-forwarded-for": "203.0.113.9" })) }));
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => revalidatePath(p) }));
vi.mock("@/lib/revalidate/listing", () => ({ revalidateListingPaths: (p: readonly string[]) => revalidateListingPaths(p) }));
vi.mock("@/lib/db/client", () => ({ db: { transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(HANDLE) } }));
vi.mock("@/lib/auth/viewer", () => ({ requireAdmin: () => requireAdmin() }));
vi.mock("@/lib/billing/paypal", () => ({ getPayPalClient: () => null }));
vi.mock("@/lib/spots/engine", () => ({ settleSpots: (...a: unknown[]) => settleSpots(...a) }));
vi.mock("@/lib/db/queries/spots", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/queries/spots")>()),
  closeSpot: (...a: unknown[]) => closeSpot(...a),
  openSpot: (...a: unknown[]) => openSpot(...a),
  setSpotFloor: (...a: unknown[]) => setSpotFloor(...a),
}));

const ADMIN: Viewer = { role: "admin", userId: "u_admin" };

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.append(k, v);
  return data;
}

beforeEach(() => {
  vi.resetModules();
  requireAdmin.mockReset().mockResolvedValue(ADMIN);
  closeSpot.mockReset().mockResolvedValue(DONE);
  openSpot.mockReset().mockResolvedValue(DONE);
  setSpotFloor.mockReset().mockResolvedValue(DONE);
  settleSpots.mockReset().mockResolvedValue({ paths: ["/leeds"], listingIds: ["l1"], changes: [] });
  revalidatePath.mockReset();
  revalidateListingPaths.mockReset();
});

describe("admin spot actions", () => {
  it("re-check the admin before touching anything", async () => {
    requireAdmin.mockRejectedValue(new Error("FORBIDDEN"));
    const { closeSpotAction, openSpotAction, setSpotFloorAction } = await import("./admin-spots");
    for (const act of [closeSpotAction, openSpotAction, setSpotFloorAction]) {
      await expect(act({ status: "idle" }, form({ key: KEY, floor: "60" }))).rejects.toThrow("FORBIDDEN");
    }
    expect(closeSpot).not.toHaveBeenCalled();
    expect(openSpot).not.toHaveBeenCalled();
    expect(setSpotFloor).not.toHaveBeenCalled();
  });

  it("close carries the ip, re-bills the listings whose bids were cancelled, and busts the spot's pages", async () => {
    const { closeSpotAction } = await import("./admin-spots");
    const out = await closeSpotAction({ status: "idle" }, form({ key: KEY }));
    expect(out).toEqual({ status: "done", key: KEY, message: expect.stringContaining("closed") });
    expect(closeSpot).toHaveBeenCalledWith(HANDLE, ADMIN, { areaKind: "city", areaId: "11111111-1111-4111-8111-111111111111", categoryId: null }, { ip: "203.0.113.9" });
    expect(settleSpots).toHaveBeenCalledWith(HANDLE, [SPOT], { client: null }, ["l1"]);
    expect(revalidateListingPaths).toHaveBeenCalledWith(["/leeds"]);
    expect(revalidatePath).toHaveBeenCalledWith("/admin/spots");
  });

  it("open and floor carry the ip too; the floor must be a whole positive amount", async () => {
    const { openSpotAction, setSpotFloorAction } = await import("./admin-spots");
    await openSpotAction({ status: "idle" }, form({ key: KEY }));
    expect(openSpot).toHaveBeenCalledWith(HANDLE, ADMIN, expect.objectContaining({ areaKind: "city" }), { ip: "203.0.113.9" });
    expect(settleSpots).not.toHaveBeenCalled();

    await setSpotFloorAction({ status: "idle" }, form({ key: KEY, floor: "75" }));
    expect(setSpotFloor).toHaveBeenCalledWith(HANDLE, ADMIN, expect.objectContaining({ areaKind: "city" }), { floorCents: 7500, ip: "203.0.113.9" });
    for (const bad of ["", "0", "12.5", "-3", "abc"]) {
      setSpotFloor.mockClear();
      const out = await setSpotFloorAction({ status: "idle" }, form({ key: KEY, floor: bad }));
      expect(out.status).toBe("error");
      expect(setSpotFloor).not.toHaveBeenCalled();
    }
  });

  it("a malformed key is refused before the database", async () => {
    const { closeSpotAction } = await import("./admin-spots");
    const out = await closeSpotAction({ status: "idle" }, form({ key: "city:nope:-" }));
    expect(out.status).toBe("error");
    expect(closeSpot).not.toHaveBeenCalled();
  });
});
