import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Viewer } from "@/lib/db/viewer";
import type { OpenRemovalRequest } from "@/lib/db/queries/trust";

/**
 * The page's own gate — same reasoning as /admin/reports, and the stakes are
 * higher here: these rows carry the name, address and stated reason of somebody
 * who wrote in asking to be taken off the site.
 */

class NotFound extends Error {}

const currentViewer = vi.fn<() => Promise<Viewer>>();
const listOpenRemovalRequests = vi.fn<() => Promise<OpenRemovalRequest[]>>();

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new NotFound("NEXT_NOT_FOUND");
  },
}));
vi.mock("@/lib/db/client", () => ({ db: { marker: "the pool" } }));
vi.mock("@/lib/auth/viewer", () => ({ currentViewer: () => currentViewer() }));
vi.mock("@/lib/db/queries/trust", () => ({
  listOpenRemovalRequests: () => listOpenRemovalRequests(),
}));

beforeEach(() => {
  vi.resetModules();
  currentViewer.mockReset();
  listOpenRemovalRequests.mockReset().mockResolvedValue([]);
});

describe("/admin/removals", () => {
  it.each<Viewer>([
    { role: "public" },
    { role: "user", userId: "user_1" },
    { role: "owner", userId: "user_2" },
  ])("404s for a $role viewer without running the query", async (viewer) => {
    currentViewer.mockResolvedValue(viewer);
    const { default: page } = await import("./page");

    await expect(page()).rejects.toThrow(NotFound);
    expect(listOpenRemovalRequests).not.toHaveBeenCalled();
  });

  it("reads the open requests for an admin", async () => {
    currentViewer.mockResolvedValue({ role: "admin", userId: "user_admin" });
    const { default: page } = await import("./page");

    await page();

    expect(listOpenRemovalRequests).toHaveBeenCalled();
  });

  it("is never indexed", async () => {
    const { metadata } = await import("./page");

    expect(metadata.robots).toMatchObject({ index: false });
  });
});
