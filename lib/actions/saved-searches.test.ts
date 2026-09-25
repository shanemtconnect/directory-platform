import { beforeEach, describe, expect, it, vi } from "vitest";
import { FEATURE_FLAGS } from "@/config/types";
import type { Viewer } from "@/lib/db/viewer";
import type { CreateSavedSearchInput, CreateSavedSearchResult } from "@/lib/db/queries/saved-searches";

/**
 * The three actions behind the save button and /account/alerts: sign-in,
 * flag and kind gates first, the input checked before a transaction opens.
 * The queries are mocked; lib/db/queries/saved-searches.test.ts covers them.
 */

const currentViewer = vi.fn<() => Promise<Viewer>>();
const createSavedSearch = vi.fn<(input: CreateSavedSearchInput) => Promise<CreateSavedSearchResult>>();
const deleteSavedSearch = vi.fn<(id: string) => Promise<boolean>>();
const setSavedSearchFrequency = vi.fn<(id: string, f: string) => Promise<boolean>>();
const revalidatePath = vi.fn<(p: string) => void>();

vi.mock("next/cache", () => ({ revalidatePath: (p: string) => revalidatePath(p) }));
vi.mock("@/lib/db/client", () => ({
  db: { transaction: (fn: (tx: unknown) => Promise<unknown>) => fn({ marker: "tx" }) },
}));
vi.mock("@/lib/auth/viewer", () => ({ currentViewer: () => currentViewer() }));
vi.mock("@/lib/db/queries/saved-searches", () => ({
  createSavedSearch: (_tx: unknown, _v: unknown, input: CreateSavedSearchInput) => createSavedSearch(input),
  deleteSavedSearch: (_tx: unknown, _v: unknown, id: string) => deleteSavedSearch(id),
  setSavedSearchFrequency: (_tx: unknown, _v: unknown, id: string, f: string) => setSavedSearchFrequency(id, f),
}));

function flags(on: { savedSearches: boolean; jobBoard: boolean }) {
  const map = Object.fromEntries(FEATURE_FLAGS.map((f) => [f, false])) as Record<string, boolean>;
  Object.assign(map, on);
  vi.doMock("@/lib/features/flags", () => ({ features: map, isEnabled: (f: string) => map[f] }));
}

const actions = () => import("./saved-searches");
const USER: Viewer = { role: "user", userId: "user_1" };
const ID = "11111111-1111-4111-8111-111111111111";
const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

beforeEach(() => {
  vi.resetModules();
  flags({ savedSearches: true, jobBoard: true });
  currentViewer.mockReset().mockResolvedValue(USER);
  createSavedSearch.mockReset().mockResolvedValue({ outcome: "created", id: ID });
  deleteSavedSearch.mockReset().mockResolvedValue(true);
  setSavedSearchFrequency.mockReset().mockResolvedValue(true);
  revalidatePath.mockReset();
});

describe("saveSearch", () => {
  it("saves the params the page handed it, with the label cleaned", async () => {
    const { saveSearch } = await actions();
    const params = { q: "barn", city: "leeds", fields: { capacity: "80" } };
    expect(await saveSearch({ kind: "listings", params, label: "  Barns\r\nin Leeds " })).toEqual({ ok: true });
    expect(createSavedSearch).toHaveBeenCalledWith({ kind: "listings", params, label: "Barns in Leeds" });
    expect(revalidatePath).toHaveBeenCalledWith("/account/alerts");
  });

  it("asks a signed-out visitor to sign in, and writes nothing", async () => {
    currentViewer.mockResolvedValue({ role: "public" });
    const { saveSearch } = await actions();
    expect(await saveSearch({ kind: "listings", params: {}, label: "x" })).toMatchObject({ ok: false, signIn: true });
    expect(createSavedSearch).not.toHaveBeenCalled();
  });

  it("refuses with the flag off, and a jobs search while the board is off", async () => {
    flags({ savedSearches: false, jobBoard: true });
    expect((await (await actions()).saveSearch({ kind: "listings", params: {}, label: "x" })).ok).toBe(false);
    vi.resetModules();
    flags({ savedSearches: true, jobBoard: false });
    const { saveSearch } = await actions();
    expect((await saveSearch({ kind: "jobs", params: {}, label: "x" })).ok).toBe(false);
    expect((await saveSearch({ kind: "listings", params: {}, label: "x" })).ok).toBe(true);
    expect(createSavedSearch).toHaveBeenCalledTimes(1);
  });

  it("refuses params that are not a small object of strings, and an unknown kind", async () => {
    const { saveSearch } = await actions();
    const bad: unknown[] = [null, [], "q=barn", { q: 1 }, { q: { deep: { deeper: "x" } } }, { q: "x".repeat(3000) }];
    for (const params of bad) {
      expect((await saveSearch({ kind: "listings", params: params as Record<string, unknown>, label: "x" })).ok).toBe(false);
    }
    expect((await saveSearch({ kind: "events" as never, params: {}, label: "x" })).ok).toBe(false);
    expect(createSavedSearch).not.toHaveBeenCalled();
  });

  it("says so at the cap", async () => {
    createSavedSearch.mockResolvedValue({ outcome: "limit" });
    const { saveSearch } = await actions();
    const result = await saveSearch({ kind: "listings", params: { q: "barn" }, label: "x" });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/10/);
  });
});

describe("the /account/alerts forms", () => {
  it("delete and frequency pass the id through and revalidate", async () => {
    const { deleteSavedSearchAction, setSavedSearchFrequencyAction } = await actions();
    await deleteSavedSearchAction(form({ id: ID }));
    expect(deleteSavedSearch).toHaveBeenCalledWith(ID);
    await setSavedSearchFrequencyAction(form({ id: ID, frequency: "daily" }));
    expect(setSavedSearchFrequency).toHaveBeenCalledWith(ID, "daily");
    expect(revalidatePath).toHaveBeenCalledWith("/account/alerts");
  });

  it("ignores a bad frequency, a signed-out viewer and a flag-off site", async () => {
    const { setSavedSearchFrequencyAction, deleteSavedSearchAction } = await actions();
    await setSavedSearchFrequencyAction(form({ id: ID, frequency: "hourly" }));
    currentViewer.mockResolvedValue({ role: "public" });
    await deleteSavedSearchAction(form({ id: ID }));
    vi.resetModules();
    flags({ savedSearches: false, jobBoard: false });
    currentViewer.mockResolvedValue(USER);
    await (await actions()).deleteSavedSearchAction(form({ id: ID }));
    expect(setSavedSearchFrequency).not.toHaveBeenCalled();
    expect(deleteSavedSearch).not.toHaveBeenCalled();
  });
});
