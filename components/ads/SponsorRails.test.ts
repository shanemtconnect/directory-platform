import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SponsorCardData } from "@/lib/db/queries/ads";

const activeSponsorCampaigns = vi.fn<(...a: unknown[]) => Promise<SponsorCardData[]>>();
vi.mock("@/lib/db/client", () => ({ db: { marker: "the pool" } }));
vi.mock("@/lib/db/queries/ads", () => ({
  activeSponsorCampaigns: (...args: unknown[]) => activeSponsorCampaigns(...args),
}));
vi.mock("@/lib/observability/build-id", () => ({ currentBuildId: () => "build-x" }));
// The box reads the database itself (and is tested in its own file); here it
// only has to be mounted, so a stand-in that renders nothing.
vi.mock("@/components/leads/LeadCaptureBox", () => ({ LeadCaptureBox: async () => null }));
let leadMarketplace = false;
vi.mock("@/lib/features/flags", () => ({
  get features() {
    return { leadMarketplace };
  },
  isEnabled: (flag: string) => flag === "leadMarketplace" && leadMarketplace,
}));

const { elements, text } = await import("@/test/elements");

const campaign = (n: number): SponsorCardData => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  name: `S${n}`, logoPath: null, title: `T${n}`, blurb: `B${n}`, weight: 1,
});

function state(node: unknown): unknown {
  return [...elements(node as never)]
    .map((e) => (e.props as Record<string, unknown>)["data-state"])
    .find((v) => v !== undefined);
}

function testIds(node: unknown): string[] {
  return [...elements(node as never)]
    .map((e) => (e.props as Record<string, unknown>)["data-testid"])
    .filter((v): v is string => typeof v === "string");
}

beforeEach(() => {
  vi.resetModules();
  activeSponsorCampaigns.mockReset().mockResolvedValue([campaign(1), campaign(2)]);
  delete process.env.ADS_ENABLED;
  delete process.env.SITE_ENV;
  leadMarketplace = false;
});

describe("SponsorRails", () => {
  it("renders nothing when the policy says off, and never queries", async () => {
    process.env.ADS_ENABLED = "false";
    const { SponsorRails } = await import("./SponsorRails");
    expect(await SponsorRails({ placement: "cityPillar" })).toBeNull();
    expect(activeSponsorCampaigns).not.toHaveBeenCalled();
  });

  it("renders the placeholder on staging without a database read", async () => {
    process.env.ADS_ENABLED = "true";
    const { SponsorRails } = await import("./SponsorRails");
    const el = await SponsorRails({ placement: "search" });
    expect(state(el)).toBe("placeholder");
    expect(text(el)).toContain("Sponsor slot");
    expect(activeSponsorCampaigns).not.toHaveBeenCalled();
  });

  it("in production renders two rails and the inline slot from the query for that placement", async () => {
    process.env.ADS_ENABLED = "true";
    process.env.SITE_ENV = "production";
    const { SponsorRails } = await import("./SponsorRails");
    const el = await SponsorRails({ placement: "listingDetail", listing: { tier: "free", claimStatus: "claimed" } });
    expect(state(el)).toBe("live");
    const ids = testIds(el);
    expect(ids).toContain("sponsor-rail-left");
    expect(ids).toContain("sponsor-rail-right");
    expect(ids).toContain("sponsor-inline");
    expect(activeSponsorCampaigns.mock.calls[0]![2]).toMatchObject({ placement: "listingDetail" });
    expect(text(el)).toContain("Sponsored");
  });

  it("a paid listing page gets nothing", async () => {
    process.env.ADS_ENABLED = "true";
    process.env.SITE_ENV = "production";
    const { SponsorRails } = await import("./SponsorRails");
    expect(await SponsorRails({ placement: "listingDetail", listing: { tier: "premium", claimStatus: "verified" } })).toBeNull();
  });
});

describe("SponsorRails — the lead-capture house slot", () => {
  async function captureIn(el: unknown) {
    const { LeadCaptureBox } = await import("@/components/leads/LeadCaptureBox");
    return [...elements(el as never)].filter((e) => e.type === LeadCaptureBox);
  }

  it("heads the left rail with the capture box when the lead marketplace is on", async () => {
    leadMarketplace = true;
    process.env.ADS_ENABLED = "true";
    process.env.SITE_ENV = "production";
    const { SponsorRails } = await import("./SponsorRails");

    const el = await SponsorRails({ placement: "cityPillar" });
    const found = await captureIn(el);
    expect(found).toHaveLength(1);
    expect(found[0]!.props).toEqual({ variant: "rail" });

    // Staging's placeholder rails carry it too: it is the site's own card, not an ad.
    delete process.env.SITE_ENV;
    expect(await captureIn(await SponsorRails({ placement: "cityPillar" }))).toHaveLength(1);
  });

  it("counts the capture box against MAX_PER_RAIL", async () => {
    leadMarketplace = true;
    process.env.ADS_ENABLED = "true";
    process.env.SITE_ENV = "production";
    activeSponsorCampaigns.mockResolvedValue(Array.from({ length: 20 }, (_, i) => campaign(i + 1)));
    const { MAX_PER_RAIL } = await import("@/lib/ads/inventory");
    const { SponsorRails } = await import("./SponsorRails");

    const el = await SponsorRails({ placement: "cityPillar" });
    const left = [...elements(el as never)].find(
      (e) => (e.props as Record<string, unknown>)["data-testid"] === "sponsor-rail-left",
    );
    const cards = [...elements(left as never)].filter((e) =>
      String((e.props as Record<string, unknown>)["data-testid"] ?? "").startsWith("sponsor-card-left"));
    expect(await captureIn(left)).toHaveLength(1);
    expect(cards.length + 1).toBe(MAX_PER_RAIL);
  });

  it("carries no capture box with the flag off", async () => {
    process.env.ADS_ENABLED = "true";
    process.env.SITE_ENV = "production";
    const { SponsorRails } = await import("./SponsorRails");
    expect(await captureIn(await SponsorRails({ placement: "cityPillar" }))).toHaveLength(0);
  });
});
