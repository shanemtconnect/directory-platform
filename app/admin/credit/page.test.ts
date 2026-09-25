import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Viewer } from "@/lib/db/viewer";

/** The page's own gates: the flag and the role, each a 404 with the balances query never run. */

class NotFound extends Error {}

const currentViewer = vi.fn<() => Promise<Viewer>>();
const creditBalances = vi.fn<() => Promise<unknown[]>>();
let flagOn = true;

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new NotFound("NEXT_NOT_FOUND");
  },
  redirect: () => {
    throw new Error("NEXT_REDIRECT");
  },
}));
vi.mock("@/lib/db/client", () => ({ db: { marker: "the pool" } }));
vi.mock("@/lib/features/flags", () => ({
  get features() {
    return { leadMarketplace: flagOn };
  },
}));
vi.mock("@/components/admin/nav-counts", () => ({ adminNavCounts: () => Promise.resolve({}) }));
vi.mock("@/lib/auth/viewer", () => ({ currentViewer: () => currentViewer(), requireAdmin: () => currentViewer() }));
vi.mock("@/lib/db/queries/credits", () => ({
  creditBalances: () => creditBalances(),
  adminAdjust: vi.fn(),
  profileIdByEmail: vi.fn(),
}));

const props = { searchParams: Promise.resolve({}) };

beforeEach(() => {
  vi.resetModules();
  flagOn = true;
  currentViewer.mockReset();
  creditBalances.mockReset().mockResolvedValue([]);
});

describe("/admin/credit", () => {
  it("404s when the flag is off, before the viewer is even read", async () => {
    flagOn = false;
    currentViewer.mockResolvedValue({ role: "admin", userId: "user_admin" });
    const { default: page } = await import("./page");
    await expect(page(props)).rejects.toThrow(NotFound);
    expect(currentViewer).not.toHaveBeenCalled();
    expect(creditBalances).not.toHaveBeenCalled();
  });

  it.each<Viewer>([
    { role: "public" },
    { role: "user", userId: "user_1" },
    { role: "owner", userId: "user_2" },
  ])("404s for a $role viewer without running the query", async (viewer) => {
    currentViewer.mockResolvedValue(viewer);
    const { default: page } = await import("./page");
    await expect(page(props)).rejects.toThrow(NotFound);
    expect(creditBalances).not.toHaveBeenCalled();
  });

  it("reads the balances for an admin", async () => {
    currentViewer.mockResolvedValue({ role: "admin", userId: "user_admin" });
    const { default: page } = await import("./page");
    await expect(page(props)).resolves.toBeTruthy();
    expect(creditBalances).toHaveBeenCalledTimes(1);
  });
});
