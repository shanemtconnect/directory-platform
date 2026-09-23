import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Viewer } from "@/lib/db/viewer";
import type { EmptySpotRow } from "@/lib/spots/availability";

const currentViewer = vi.fn<() => Promise<Viewer>>();
const emptySpotsReport = vi.fn<() => Promise<EmptySpotRow[]>>();
const writeAudit = vi.fn<(...a: unknown[]) => Promise<string>>();

process.env.NEXT_PUBLIC_SITE_URL = "https://example.co.uk";

vi.mock("@/lib/db/client", () => ({ db: { marker: "pool" } }));
vi.mock("@/lib/auth/viewer", () => ({ currentViewer: () => currentViewer() }));
vi.mock("@/lib/spots/availability", () => ({ emptySpotsReport: () => emptySpotsReport() }));
vi.mock("@/lib/db/queries/audit", () => ({ writeAudit: (...a: unknown[]) => writeAudit(...a) }));

const row = (patch: Partial<EmptySpotRow>): EmptySpotRow => ({
  spotId: null, key: { areaKind: "city", areaId: "c1", categoryId: null }, keyString: "city:c1:-",
  areaName: "Leeds", categoryName: null, status: "open", positions: 3, floorCents: 5000, filled: 0, topCents: null, path: "/leeds",
  ...patch,
});

beforeEach(() => {
  currentViewer.mockReset().mockResolvedValue({ role: "admin", userId: "u_admin" });
  emptySpotsReport.mockReset().mockResolvedValue([row({}), row({ areaName: "Full", filled: 3 })]);
  writeAudit.mockReset().mockResolvedValue("audit-1");
});

function get(): Request {
  return new Request("https://example.co.uk/admin/spots/export", { headers: { "x-forwarded-for": "203.0.113.9" } });
}

describe("GET /admin/spots/export", () => {
  it("serves the empty spots as a CSV download and audits the export with the ip", async () => {
    const { GET } = await import("./route");
    const res = await GET(get());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="empty-featured-spots-\d{4}-\d{2}-\d{2}\.csv"$/);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const body = await res.text();
    expect(body.split("\r\n")).toHaveLength(2);
    expect(body).toContain("city,Leeds,,0,3,3,50,,https://example.co.uk/leeds,");
    expect(writeAudit).toHaveBeenCalledWith({ marker: "pool" }, { role: "admin", userId: "u_admin" }, {
      action: "spots.export_downloaded", entityType: "featured_spot", meta: { rows: 1 }, ip: "203.0.113.9",
    });
  });

  it("404s for anyone who is not an admin, without building anything", async () => {
    const { GET } = await import("./route");
    currentViewer.mockResolvedValue({ role: "owner", userId: "u1" });
    expect((await GET(get())).status).toBe(404);
    currentViewer.mockResolvedValue({ role: "public" });
    expect((await GET(get())).status).toBe(404);
    expect(emptySpotsReport).not.toHaveBeenCalled();
    expect(writeAudit).not.toHaveBeenCalled();
  });
});
