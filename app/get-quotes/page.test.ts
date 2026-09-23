import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CategoryIndexRow } from "@/lib/db/queries/indexes";
import type { SwitcherCity } from "@/lib/db/queries/cities";
import { elements } from "@/test/elements";

/**
 * The page under both flag states. Off is a real 404 that runs no query —
 * the flag is a build-time constant, so on a clone with it off this code is
 * dead, but the unit suite runs with whatever the config says and has to
 * prove the gate either way.
 */

class NotFound extends Error {}

const listCategories = vi.fn<() => Promise<CategoryIndexRow[]>>();
const listSwitcherCities = vi.fn<() => Promise<SwitcherCity[]>>();
let quoteBroadcast = true;

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new NotFound("NEXT_NOT_FOUND");
  },
}));
vi.mock("@/lib/db/client", () => ({ db: { marker: "the pool" } }));
vi.mock("@/lib/features/flags", () => ({
  get features() {
    return { quoteBroadcast };
  },
  isEnabled: (flag: string) => flag === "quoteBroadcast" && quoteBroadcast,
}));
vi.mock("@/lib/db/queries/indexes", () => ({ listCategories: () => listCategories() }));
vi.mock("@/lib/db/queries/cities", () => ({ listSwitcherCities: () => listSwitcherCities() }));

beforeEach(() => {
  vi.resetModules();
  quoteBroadcast = true;
  listCategories.mockReset().mockResolvedValue([
    { id: "c1", name: "Barn Hall", slug: "barn-halls", plural: "Barn Halls", listingCount: 4 },
  ]);
  listSwitcherCities.mockReset().mockResolvedValue([
    { id: "t1", name: "Bath", slug: "bath", listingCount: 12, isCurrent: false },
  ]);
});

describe("/get-quotes", () => {
  it("404s with the flag off, without touching the database", async () => {
    quoteBroadcast = false;
    const { default: page } = await import("./page");

    await expect(page()).rejects.toThrow(NotFound);
    expect(listCategories).not.toHaveBeenCalled();
    expect(listSwitcherCities).not.toHaveBeenCalled();
  });

  it("feeds the form the categories and the switcher's towns with the flag on", async () => {
    const { default: page } = await import("./page");
    const { QuoteRequestForm } = await import("@/components/quotes/QuoteRequestForm");
    const tree = await page();

    const form = [...elements(tree)].find((el) => el.type === QuoteRequestForm);
    expect(form).toBeDefined();
    const props = form!.props as { categories: { id: string; name: string }[]; towns: { id: string; name: string }[] };
    expect(props.categories).toEqual([{ id: "c1", name: "Barn Halls" }]);
    expect(props.towns).toEqual([{ id: "t1", name: "Bath" }]);
  });

  it("is rendered per request", async () => {
    const { dynamic } = await import("./page");
    expect(dynamic).toBe("force-dynamic");
  });
});
