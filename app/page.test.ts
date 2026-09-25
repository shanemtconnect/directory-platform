import { beforeEach, describe, expect, it, vi } from "vitest";
import { elements } from "@/test/elements";

/**
 * The home page's lead-capture box (Task 56): mounted below the fold, after
 * the browse sections, and rendering nothing on a flag-off build. The box's
 * own behaviour is tested in components/leads/LeadCaptureBox.test.ts.
 */

let leadMarketplace = false;

vi.mock("@/lib/db/client", () => ({ db: { marker: "the pool" } }));
vi.mock("@/lib/db/build-phase", () => ({ prerenderingWithoutDatabase: () => false }));
vi.mock("@/lib/db/queries/homepage", () => ({
  topCities: async () => [],
  topCategories: async () => [],
  featuredListings: async () => [],
}));
vi.mock("@/lib/db/queries/indexes", () => ({
  listCategories: async () => [{ id: "c1", name: "Hall", slug: "halls", plural: "Halls", listingCount: 1 }],
}));
vi.mock("@/lib/db/queries/cities", () => ({
  listSwitcherCities: async () => [{ id: "t1", name: "Bath", slug: "bath", listingCount: 3, isCurrent: false }],
}));
vi.mock("@/lib/features/flags", () => ({
  get features() {
    return { leadMarketplace };
  },
  isEnabled: (flag: string) => flag === "leadMarketplace" && leadMarketplace,
}));

beforeEach(() => {
  vi.resetModules();
  leadMarketplace = false;
});

async function renderedCaptureBoxes() {
  const { default: HomePage } = await import("./page");
  const { LeadCaptureBox } = await import("@/components/leads/LeadCaptureBox");
  const { BrowseByType } = await import("@/components/home/BrowseByType");
  const tree = await HomePage();
  const all = [...elements(tree)];
  const boxes = all.filter((el) => el.type === LeadCaptureBox);
  const rendered = await Promise.all(boxes.map((b) => LeadCaptureBox(b.props as { variant: "home" })));
  return { all, boxes, rendered, BrowseByType };
}

describe("home page — lead capture", () => {
  it("has no capture box on a flag-off build", async () => {
    const { rendered } = await renderedCaptureBoxes();
    expect(rendered.every((r) => r === null)).toBe(true);
  });

  it("renders the capture box below the browse sections with the flag on", async () => {
    leadMarketplace = true;
    const { all, boxes, rendered, BrowseByType } = await renderedCaptureBoxes();
    expect(boxes.map((b) => b.props)).toEqual([{ variant: "home" }]);
    expect(rendered[0]).not.toBeNull();
    expect(all.indexOf(boxes[0]!)).toBeGreaterThan(all.findIndex((el) => el.type === BrowseByType));
  });
});
