import { describe, it, expect } from "vitest";
import { navCountsFrom } from "./nav-counts";

describe("navCountsFrom", () => {
  it("keys every non-zero queue by its nav href and drops the zeros", () => {
    expect(
      navCountsFrom({
        pendingSubmissions: 3,
        citiesAwaitingIntro: 0,
        pendingClaims: 1,
        openReports: 0,
        openRemovals: 2,
        reviewsAwaitingModeration: 5,
      }),
    ).toEqual({
      "/admin/submissions": 3,
      "/admin/claims": 1,
      "/admin/removals": 2,
      "/admin/reviews": 5,
    });
  });
});
