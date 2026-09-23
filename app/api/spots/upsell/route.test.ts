import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Viewer } from "@/lib/db/viewer";
import type { UpsellCandidate } from "@/lib/db/queries/spots";

const currentViewer = vi.fn<() => Promise<Viewer>>();
const upsellCandidate = vi.fn<(...a: unknown[]) => Promise<UpsellCandidate | null>>();
const ensureProfile = vi.fn<() => Promise<{ id: string }>>();

vi.mock("@/lib/db/client", () => ({ db: { marker: "pool" } }));
vi.mock("@/lib/auth/viewer", () => ({ currentViewer: () => currentViewer() }));
vi.mock("@/lib/auth/profile", () => ({ ensureProfile: () => ensureProfile() }));
vi.mock("@/lib/db/queries/spots", () => ({ upsellCandidate: (...a: unknown[]) => upsellCandidate(...a) }));

const CITY = "11111111-1111-4111-8111-111111111111";
const LISTING = "22222222-2222-4222-8222-222222222222";
const PROFILE = "33333333-3333-4333-8333-333333333333";

function get(key: string | null, cookie?: string): Request {
  const url = new URL("http://localhost:3245/api/spots/upsell");
  if (key !== null) url.searchParams.set("key", key);
  return new Request(url, { headers: cookie === undefined ? {} : { cookie } });
}

beforeEach(() => {
  currentViewer.mockReset().mockResolvedValue({ role: "owner", userId: "u1" });
  ensureProfile.mockReset().mockResolvedValue({ id: PROFILE });
  upsellCandidate.mockReset().mockResolvedValue({ listingId: LISTING, listingName: "The Old Hall", fromCents: 5000 });
});

describe("GET /api/spots/upsell", () => {
  it("answers 204 to a visitor with no session cookie without looking anything up", async () => {
    const { GET } = await import("./route");
    const res = await GET(get(`city:${CITY}:-`));
    expect(res.status).toBe(204);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(currentViewer).not.toHaveBeenCalled();
  });

  it("answers the signed-in owner's candidate with the bidding link, never cached", async () => {
    const { GET } = await import("./route");
    const res = await GET(get(`city:${CITY}:-`, "dir.session_token=abc"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(await res.json()).toEqual({
      listingId: LISTING, listingName: "The Old Hall", fromCents: 5000, href: `/account/listings/${LISTING}/featured`,
    });
    expect(upsellCandidate).toHaveBeenCalledWith({ marker: "pool" }, { role: "owner", userId: "u1" }, PROFILE, {
      areaKind: "city", areaId: CITY, categoryId: null,
    });
  });

  it("204 for a signed-in visitor with nothing to be sold, and for a cookie that is not a session", async () => {
    const { GET } = await import("./route");
    upsellCandidate.mockResolvedValue(null);
    expect((await GET(get(`region:west-yorkshire:-`, "dir.session_token=abc"))).status).toBe(204);
    currentViewer.mockResolvedValue({ role: "public" });
    expect((await GET(get(`region:west-yorkshire:-`, "dir.session_token=abc"))).status).toBe(204);
  });

  it("400 for a malformed key", async () => {
    const { GET } = await import("./route");
    for (const bad of [null, "city:nope:-", "region:West Yorkshire:-", `city:${CITY}:nope`, `city:${CITY}`]) {
      expect((await GET(get(bad, "dir.session_token=abc"))).status).toBe(400);
    }
    expect(currentViewer).not.toHaveBeenCalled();
  });
});
