import { describe, expect, it } from "vitest";
import type { OwnerListing, OwnerNextActions } from "@/lib/db/queries/owner";
import { nextActionFor } from "./next-action";

const ID = "33333333-3333-4333-8333-333333333333";

function listing(patch: Partial<OwnerListing> = {}): OwnerListing {
  return {
    id: ID, name: "The Old Hall", path: "/richmond/the-old-hall", status: "published",
    tier: "free", claimStatus: "verified", enquiryCount: 0, unreadEnquiries: 0, ...patch,
  };
}

function actions(patch: Partial<OwnerNextActions> = {}): OwnerNextActions {
  return { unrepliedReviews: 0, photoCount: 1, claimStatus: "verified", status: "published", ...patch };
}

describe("nextActionFor", () => {
  it("puts an unread enquiry before everything else", () => {
    expect(nextActionFor(listing({ unreadEnquiries: 2 }), actions({ unrepliedReviews: 3, photoCount: 0 })))
      .toEqual({ label: "Reply to 2 unread enquiries", href: `/account/listings/${ID}/enquiries` });
  });

  it("then unanswered reviews, to the account reviews route", () => {
    expect(nextActionFor(listing(), actions({ unrepliedReviews: 1, photoCount: 0 })))
      .toEqual({ label: "Reply to 1 review", href: `/account/listings/${ID}/reviews` });
    expect(nextActionFor(listing(), actions({ unrepliedReviews: 4 })).label).toBe("Reply to 4 reviews");
  });

  it("then missing photos, to the photos page", () => {
    expect(nextActionFor(listing({ claimStatus: "claimed" }), actions({ photoCount: 0 })))
      .toEqual({ label: "Add photos", href: `/account/listings/${ID}/photos` });
  });

  it("then claim, then verification", () => {
    expect(nextActionFor(listing({ claimStatus: "unclaimed" }), actions()))
      .toEqual({ label: "Claim this listing", href: `/claim/${ID}` });
    expect(nextActionFor(listing({ claimStatus: "claimed" }), actions()))
      .toEqual({ label: "Get verified", href: "/pricing" });
  });

  it("falls through to the editor when everything is done", () => {
    expect(nextActionFor(listing(), actions()).href).toBe(`/account/listings/${ID}`);
  });

  it("says a pending listing is being reviewed, with nothing to click", () => {
    expect(nextActionFor(listing({ status: "pending" }), actions({ photoCount: 0 })).href).toBeNull();
  });

  it("still answers when the count query saw nothing", () => {
    expect(nextActionFor(listing({ claimStatus: "claimed" }), null))
      .toEqual({ label: "Get verified", href: "/pricing" });
  });
});
