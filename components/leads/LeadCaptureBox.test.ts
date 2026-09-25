import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CategoryIndexRow } from "@/lib/db/queries/indexes";
import type { SwitcherCity } from "@/lib/db/queries/cities";
import { elements, text } from "@/test/elements";

const listCategories = vi.fn<() => Promise<CategoryIndexRow[]>>();
const listSwitcherCities = vi.fn<() => Promise<SwitcherCity[]>>();
let leadMarketplace = true;
let prerendering = false;

vi.mock("@/lib/db/client", () => ({ db: { marker: "the pool" } }));
vi.mock("@/lib/db/build-phase", () => ({ prerenderingWithoutDatabase: () => prerendering }));
vi.mock("@/lib/features/flags", () => ({
  get features() {
    return { leadMarketplace };
  },
  isEnabled: (flag: string) => flag === "leadMarketplace" && leadMarketplace,
}));
vi.mock("@/lib/db/queries/indexes", () => ({ listCategories: () => listCategories() }));
vi.mock("@/lib/db/queries/cities", () => ({ listSwitcherCities: () => listSwitcherCities() }));

beforeEach(() => {
  vi.resetModules();
  leadMarketplace = true;
  prerendering = false;
  listCategories.mockReset().mockResolvedValue([
    { id: "c1", name: "Barn Hall", slug: "barn-halls", plural: "Barn Halls", listingCount: 4 },
  ]);
  listSwitcherCities.mockReset().mockResolvedValue([
    { id: "t1", name: "Bath", slug: "bath", listingCount: 12, isCurrent: false },
  ]);
});

async function box(variant: "home" | "rail") {
  const { LeadCaptureBox } = await import("./LeadCaptureBox");
  return LeadCaptureBox({ variant });
}

describe("LeadCaptureBox", () => {
  it("renders nothing with the flag off, and reads nothing", async () => {
    leadMarketplace = false;
    expect(await box("home")).toBeNull();
    expect(await box("rail")).toBeNull();
    expect(listCategories).not.toHaveBeenCalled();
    expect(listSwitcherCities).not.toHaveBeenCalled();
  });

  it("renders nothing while a build prerenders without a database, or with nothing to offer", async () => {
    prerendering = true;
    expect(await box("home")).toBeNull();
    expect(listCategories).not.toHaveBeenCalled();

    prerendering = false;
    listSwitcherCities.mockResolvedValue([]);
    expect(await box("home")).toBeNull();
  });

  it("on the home page, a card whose form is fed the categories and towns", async () => {
    const { LeadCaptureForm } = await import("./LeadCaptureForm");
    const tree = await box("home");
    const all = [...elements(tree)];

    expect((all[0]!.props as Record<string, unknown>)["data-testid"]).toBe("lead-capture");
    expect((all[0]!.props as Record<string, unknown>)["data-variant"]).toBe("home");
    const form = all.find((el) => el.type === LeadCaptureForm);
    expect(form?.props).toMatchObject({
      categories: [{ id: "c1", name: "Barn Halls" }],
      towns: [{ id: "t1", name: "Bath" }],
      idPrefix: "lead-capture-home",
    });
  });

  it("in a rail, a house card that opens into the form", async () => {
    const tree = await box("rail");
    const root = [...elements(tree)][0]!;
    expect(root.type).toBe("details");
    expect((root.props as Record<string, unknown>)["data-variant"]).toBe("rail");
    expect(text(tree)).toMatch(/Need a /);
  });
});
