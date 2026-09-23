import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Viewer } from "@/lib/db/viewer";
import type { ReconcileOutcome } from "@/lib/billing/subscriptions";
import type { OwnerSubscription } from "@/lib/db/queries/billing";

/**
 * The return page reconciles with PayPal and writes the answer through the
 * same state machine as the webhook. Whatever that machine applied — an
 * activation, a cancellation it caught up on, an expiry — changed the tier
 * the public pages print, and an ISR page that still shows the old tier for
 * up to an hour is the bug. So the cache is busted on EVERY applied change,
 * not only the one the page congratulates the buyer on.
 */

const currentViewer = vi.fn<() => Promise<Viewer>>();
const reconcileSubscription = vi.fn<() => Promise<ReconcileOutcome>>();
const subscriptionForOwnerByProviderId = vi.fn<() => Promise<OwnerSubscription | null>>();
const revalidateListingPaths = vi.fn<(paths: readonly string[]) => void>();
// `after` runs its callback once the response has been sent; here it runs it
// at once so the assertions below see the call. What matters is that the
// page never calls the helper outside `after` — see the test at the foot.
const after = vi.fn<(fn: () => void) => void>((fn) => fn());
vi.mock("next/server", () => ({ after: (fn: () => void) => after(fn) }));

const HANDLE = { marker: "the transaction" };
const transaction = vi.fn(
  async <T,>(fn: (tx: unknown) => Promise<T>): Promise<T> => await fn(HANDLE),
);

vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
}));
vi.mock("@/lib/revalidate/listing", () => ({
  revalidateListingPaths: (paths: readonly string[]) => revalidateListingPaths(paths),
}));
vi.mock("@/lib/db/client", () => ({ db: { transaction: (fn: never) => transaction(fn) } }));
vi.mock("@/lib/auth/viewer", () => ({ currentViewer: () => currentViewer() }));
vi.mock("@/lib/auth/profile", () => ({
  ensureProfile: () => Promise.resolve({ id: "44444444-4444-4444-8444-444444444444" }),
}));
vi.mock("@/lib/billing/paypal", () => ({ getPayPalClient: () => ({ marker: "paypal" }) }));
vi.mock("@/lib/billing/subscriptions", () => ({
  reconcileSubscription: (...args: unknown[]) => reconcileSubscription(...(args as [])),
}));
vi.mock("@/lib/db/queries/billing", () => ({
  subscriptionForOwnerByProviderId: (...args: unknown[]) =>
    subscriptionForOwnerByProviderId(...(args as [])),
}));

const OWNED = {
  listingPath: "/richmond/the-old-hall",
  cityPath: "/richmond",
} as unknown as OwnerSubscription;

/** What `applyEffect` reports through `reconcileSubscription`: `listingPaths`, read in the transaction. */
const PATHS = ["/richmond/the-old-hall", "/richmond/the-old-hall/reviews", "/richmond", "/richmond/page/2", "/richmond/halls"];

async function render() {
  const { default: page } = await import("./page");
  return await page({ searchParams: Promise.resolve({ subscription_id: "I-ABC123" }) });
}

beforeEach(() => {
  vi.resetModules();
  currentViewer.mockReset().mockResolvedValue({ role: "owner", userId: "user_owner" });
  subscriptionForOwnerByProviderId.mockReset().mockResolvedValue(OWNED);
  reconcileSubscription.mockReset();
  revalidateListingPaths.mockReset();
  after.mockClear();
});

describe("/checkout/return", () => {
  it("busts every page the state machine reports when the activation is applied", async () => {
    reconcileSubscription.mockResolvedValue({ outcome: "applied", action: "activate", paths: PATHS });

    await render();

    // The page names no paths of its own: the list is `listingPaths`, read
    // inside the transaction, so a paginated city page or the category pillar
    // is busted here exactly as it is for the webhook.
    expect(revalidateListingPaths).toHaveBeenCalledTimes(1);
    expect(revalidateListingPaths).toHaveBeenCalledWith(PATHS);
    // Revalidation is deferred past the render: inline it would throw in Next.
    expect(after).toHaveBeenCalledTimes(1);
  });

  it.each(["cancel", "expire", "suspend", "reactivate"])(
    "busts the same pages for any other applied change (%s) — the tier moved either way",
    async (action) => {
      reconcileSubscription.mockResolvedValue({ outcome: "applied", action, paths: PATHS });

      await render();

      expect(revalidateListingPaths).toHaveBeenCalledWith(PATHS);
    },
  );

  it("leaves the cache alone when nothing was applied", async () => {
    reconcileSubscription.mockResolvedValue({ outcome: "pending", status: "APPROVAL_PENDING" });

    await render();

    expect(revalidateListingPaths).not.toHaveBeenCalled();
  });

  it("never reconciles or revalidates a subscription this viewer does not own", async () => {
    subscriptionForOwnerByProviderId.mockResolvedValue(null);

    await render();

    expect(reconcileSubscription).not.toHaveBeenCalled();
    expect(revalidateListingPaths).not.toHaveBeenCalled();
  });
});
