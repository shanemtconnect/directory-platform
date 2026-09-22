import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Viewer } from "@/lib/db/viewer";
import type { OwnerListingDetail } from "@/lib/db/queries/owner";
import type { OwnerQuoteLead } from "@/lib/db/queries/quotes";
import { elements } from "@/test/elements";

class NotFound extends Error {}

const currentViewer = vi.fn<() => Promise<Viewer>>();
const ownerListing = vi.fn<() => Promise<OwnerListingDetail | null>>();
const ownerQuoteLeads = vi.fn<(...a: unknown[]) => Promise<OwnerQuoteLead[]>>();

const DB = { marker: "the pool" };

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new NotFound("NEXT_NOT_FOUND");
  },
}));
vi.mock("@/lib/db/client", () => ({ db: DB }));
vi.mock("@/lib/auth/viewer", () => ({ currentViewer: () => currentViewer() }));
vi.mock("@/lib/db/queries/owner", () => ({ ownerListing: () => ownerListing() }));
vi.mock("@/lib/db/queries/quotes", () => ({
  ownerQuoteLeads: (...args: unknown[]) => ownerQuoteLeads(...args),
}));

const OWNER: Viewer = { role: "owner", userId: "user_owner" };
const LISTING_ID = "33333333-3333-4333-8333-333333333333";
const LISTING: OwnerListingDetail = {
  id: LISTING_ID, name: "The Old Hall", path: "/richmond/the-old-hall", status: "published",
  tier: "free", claimStatus: "claimed", enquiryCount: 0, description: null, phone: null,
  website: null, socials: null, openingHours: null,
};
const LEAD: OwnerQuoteLead = {
  id: "44444444-4444-4444-8444-444444444444", createdAt: new Date("2026-09-22T10:00:00Z"),
  cityName: "Richmond", categoryName: "Barn Halls", outcome: "open", outcomeAt: null,
  contactVisible: false, job: null, requester: null,
};

async function render() {
  const { default: page } = await import("./page");
  return await page({ params: Promise.resolve({ id: LISTING_ID }) });
}

beforeEach(() => {
  vi.resetModules();
  currentViewer.mockReset().mockResolvedValue(OWNER);
  ownerListing.mockReset().mockResolvedValue(LISTING);
  ownerQuoteLeads.mockReset().mockResolvedValue([LEAD]);
});

describe("/account/listings/[id]/leads", () => {
  it("reads the leads through the owner-gated query and mounts the inbox", async () => {
    const { LeadsInbox } = await import("@/components/quotes/LeadsInbox");
    const tree = await render();

    expect(ownerQuoteLeads).toHaveBeenCalledWith(DB, OWNER, LISTING_ID);
    const inbox = [...elements(tree)].find((el) => el.type === LeadsInbox);
    expect(inbox).toBeDefined();
    const props = inbox!.props as { leads: { id: string; contactVisible: boolean; createdAt: string }[] };
    expect(props.leads).toEqual([expect.objectContaining({
      id: LEAD.id, contactVisible: false, createdAt: "2026-09-22T10:00:00.000Z",
    })]);
  });

  it("404s for a listing this viewer does not own, without reading its leads", async () => {
    ownerListing.mockResolvedValue(null);

    await expect(render()).rejects.toThrow(NotFound);
    expect(ownerQuoteLeads).not.toHaveBeenCalled();
  });

  it("is never indexed", async () => {
    const { metadata } = await import("./page");
    expect(metadata.robots).toMatchObject({ index: false });
  });
});
