import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Viewer } from "@/lib/db/viewer";
import type { OwnerUpdateResult } from "@/lib/db/queries/owner";

/**
 * The owner's edit, with the database mocked out.
 *
 * What the update does is `updateOwnerListing` and is tested against a real
 * transaction in lib/db/queries/owner.test.ts. What is only testable HERE is
 * what the action does with the answer: the public listing page is ISR, and
 * the action busts exactly the list the query reports through the one
 * revalidate helper — plus the owner's own edit page, which is not a listing
 * path and is the one path this action is entitled to name.
 */

const currentViewer = vi.fn<() => Promise<Viewer>>();
const updateOwnerListing = vi.fn<(...a: unknown[]) => Promise<OwnerUpdateResult>>();
const revalidateListingPaths = vi.fn<(paths: readonly string[]) => void>();
const revalidatePath = vi.fn<(path: string) => void>();

const HANDLE = { marker: "the transaction" };
const transaction = vi.fn(
  async <T,>(fn: (tx: unknown) => Promise<T>): Promise<T> => await fn(HANDLE),
);

vi.mock("next/headers", () => ({
  headers: () => Promise.resolve(new Headers({ "x-forwarded-for": "203.0.113.9" })),
}));
vi.mock("next/cache", () => ({ revalidatePath: (path: string) => revalidatePath(path) }));
vi.mock("@/lib/db/client", () => ({ db: { transaction: (fn: never) => transaction(fn) } }));
vi.mock("@/lib/auth/viewer", () => ({ currentViewer: () => currentViewer() }));
vi.mock("@/lib/db/queries/owner", () => ({
  markEnquiryHandled: vi.fn(),
  updateOwnerListing: (...args: unknown[]) => updateOwnerListing(...args),
}));
vi.mock("@/lib/revalidate/listing", () => ({
  revalidateListingPaths: (paths: readonly string[]) => revalidateListingPaths(paths),
}));

const OWNER: Viewer = { role: "owner", userId: "user_owner" };
const LISTING_ID = "11111111-1111-4111-8111-111111111111";
const PATHS = ["/leeds/the-old-mill", "/leeds/the-old-mill/reviews", "/leeds", "/leeds/page/2", "/leeds/mills"];

function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

const VALID = {
  listingId: LISTING_ID,
  description: "A converted watermill on the river, with room for a hundred and twenty.",
  phone: "01632 960111",
  website: "https://oldmill.example",
};

async function save(fields: Record<string, string>) {
  const { saveOwnerListing } = await import("./owner");
  return saveOwnerListing({ status: "idle" }, form(fields));
}

beforeEach(() => {
  vi.resetModules();
  currentViewer.mockReset().mockResolvedValue(OWNER);
  updateOwnerListing.mockReset();
  revalidateListingPaths.mockReset();
  revalidatePath.mockReset();
  transaction.mockClear();
});

describe("saveOwnerListing", () => {
  it("busts every page the query reports through the one helper, and the owner's own edit page", async () => {
    updateOwnerListing.mockResolvedValue({ outcome: "saved", paths: PATHS });

    const state = await save(VALID);

    expect(state).toEqual({ status: "saved" });
    expect(updateOwnerListing).toHaveBeenCalledWith(
      HANDLE, OWNER, LISTING_ID, expect.objectContaining({ phone: "01632 960111" }), "203.0.113.9",
    );
    expect(revalidateListingPaths).toHaveBeenCalledTimes(1);
    expect(revalidateListingPaths).toHaveBeenCalledWith(PATHS);
    // The account page is not a listing path; it is the one path the action
    // names itself.
    expect(revalidatePath).toHaveBeenCalledTimes(1);
    expect(revalidatePath).toHaveBeenCalledWith(`/account/listings/${LISTING_ID}`);
  });

  it("busts nothing when the listing is not this owner's", async () => {
    updateOwnerListing.mockResolvedValue({ outcome: "not-found" });

    const state = await save(VALID);

    expect(state.status).toBe("error");
    expect(revalidateListingPaths).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("opens no transaction and busts nothing for a signed-out caller", async () => {
    currentViewer.mockResolvedValue({ role: "public" });

    const state = await save(VALID);

    expect(state.status).toBe("error");
    expect(transaction).not.toHaveBeenCalled();
    expect(revalidateListingPaths).not.toHaveBeenCalled();
  });
});
