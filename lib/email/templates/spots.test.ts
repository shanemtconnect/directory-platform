import { describe, expect, it } from "vitest";
import { spotDigestToAdmin, spotDigestToOwner, spotOutbid } from "./spots";

/**
 * What these emails may and may not say. The owner is told what it takes to
 * get back and where to click; never what anybody else bid. The digest says
 * how many spots are empty and the cheapest way in.
 */
describe("spotOutbid", () => {
  const base = {
    listingName: "The Old Hall",
    spotLabel: "Leeds",
    positions: 3,
    amount: "£66",
    bidUrl: "https://example.co.uk/account/listings/1/featured?bid=city:c:-&amount=66",
    leaderboardUrl: "https://example.co.uk/spots/s1",
  };

  it("lost first: names the new position and the amount to retake #1, links the prefilled bid", () => {
    const m = spotOutbid({ ...base, kind: "lost-first", position: 2 });
    expect(m.subject).toContain("The Old Hall");
    expect(m.text).toContain("#2");
    expect(m.text).toContain("£66");
    expect(m.text).toContain("amount=66");
    expect(m.html).toContain('href="https://example.co.uk/account/listings/1/featured?bid=city:c:-&amp;amount=66"');
    expect(m.text).toContain(base.leaderboardUrl);
  });

  it("dropped out: says the listing is no longer featured and the amount to get back in", () => {
    const m = spotOutbid({ ...base, kind: "dropped-out", position: null, amount: "£61" });
    expect(m.subject.toLowerCase()).toContain("no longer featured");
    expect(m.text).toContain("£61");
    // Nothing about anybody else's bid: no second amount anywhere.
    expect(new Set(m.text.match(/£\d+/g))).toEqual(new Set(["£61"]));
  });
});

describe("spotDigestToOwner", () => {
  it("counts the empty spots, states the lowest entry price, and carries the opt-out when there is one", () => {
    const m = spotDigestToOwner({
      listingName: "The Old Hall",
      emptyCount: 4,
      fromAmount: "£50",
      bidUrl: "https://example.co.uk/account/listings/1/featured",
      unsubscribeToken: "tok.sig",
    });
    expect(m.subject).toContain("4 spots near you are empty");
    expect(m.text).toContain("from £50/month");
    expect(m.text).toContain("/unsubscribe?t=tok.sig");
    const none = spotDigestToOwner({ listingName: "x", emptyCount: 1, fromAmount: "£50", bidUrl: "u", unsubscribeToken: null });
    expect(none.subject).toContain("1 spot near you is empty");
    expect(none.text).not.toContain("/unsubscribe");
  });
});

describe("spotDigestToAdmin", () => {
  it("lists every empty spot as one line and links the CSV", () => {
    const m = spotDigestToAdmin({
      rows: [
        { label: "Leeds", filled: 1, positions: 3, floor: "£50", top: "£60" },
        { label: "Plumbing in Leeds", filled: 0, positions: 3, floor: "£50", top: "—" },
      ],
      csvUrl: "https://example.co.uk/admin/spots/export",
      total: 2,
    });
    expect(m.subject).toContain("2 empty");
    expect(m.text).toContain("Leeds: 1 of 3 taken, floor £50, top £60");
    expect(m.text).toContain("Plumbing in Leeds: 0 of 3 taken, floor £50, top —");
    expect(m.text).toContain("/admin/spots/export");
  });
});
