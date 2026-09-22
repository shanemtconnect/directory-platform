import { describe, expect, it } from "vitest";
import {
  minimumToEnter,
  minimumToTakeFirst,
  quantityFor,
  rankBids,
  roundUpToUnit,
  validateBid,
  validateLower,
  type RankableBid,
} from "./rank";

const at = (iso: string) => new Date(iso);

function bid(
  id: string,
  amountCents: number,
  createdAt: string,
  status: RankableBid["status"] = "active",
): RankableBid {
  return { id, listingId: `L-${id}`, amountCents, createdAt: at(createdAt), status };
}

describe("rankBids", () => {
  it("orders by amount desc, then created_at asc, and hands out positions 1..N", () => {
    const ranked = rankBids(
      [
        bid("a", 5000, "2026-09-01T00:00:00Z"),
        bid("b", 8000, "2026-09-02T00:00:00Z"),
        bid("c", 5000, "2026-08-30T00:00:00Z"),
      ],
      3,
    );
    expect(ranked.map((r) => [r.id, r.position])).toEqual([
      ["b", 1],
      ["c", 2], // same amount as a, but earlier
      ["a", 3],
    ]);
  });

  it("leaves everything past the top N with a null position", () => {
    const ranked = rankBids(
      [
        bid("a", 9000, "2026-09-01T00:00:00Z"),
        bid("b", 8000, "2026-09-01T00:00:00Z"),
        bid("c", 7000, "2026-09-01T00:00:00Z"),
        bid("d", 6000, "2026-09-01T00:00:00Z"),
      ],
      3,
    );
    expect(ranked.find((r) => r.id === "d")?.position).toBeNull();
    expect(ranked.filter((r) => r.position !== null)).toHaveLength(3);
  });

  it("ranks only confirmed bids: pending and cancelled ones are not in the running", () => {
    const ranked = rankBids(
      [
        bid("p", 99_000, "2026-09-01T00:00:00Z", "pending"),
        bid("x", 99_000, "2026-09-01T00:00:00Z", "cancelled"),
        bid("o", 5000, "2026-09-03T00:00:00Z", "outbid"),
        bid("a", 5000, "2026-09-02T00:00:00Z", "active"),
      ],
      3,
    );
    expect(ranked.map((r) => r.id)).toEqual(["a", "o"]);
    expect(ranked.map((r) => r.position)).toEqual([1, 2]);
  });

  it("breaks an exact tie on id so the order is total and stable", () => {
    const a = rankBids([bid("b", 100, "2026-09-01T00:00:00Z"), bid("a", 100, "2026-09-01T00:00:00Z")], 1);
    const b = rankBids([bid("a", 100, "2026-09-01T00:00:00Z"), bid("b", 100, "2026-09-01T00:00:00Z")], 1);
    expect(a.map((r) => r.id)).toEqual(["a", "b"]);
    expect(b.map((r) => r.id)).toEqual(["a", "b"]);
  });
});

describe("roundUpToUnit", () => {
  it("rounds up to the next whole unit and leaves whole units alone", () => {
    expect(roundUpToUnit(5501)).toBe(5600);
    expect(roundUpToUnit(5500)).toBe(5500);
    expect(roundUpToUnit(1)).toBe(100);
    expect(roundUpToUnit(0)).toBe(0);
  });
});

describe("minimumToTakeFirst", () => {
  it("is the floor when nobody is featured", () => {
    expect(minimumToTakeFirst({ floorCents: 5000, positions: 3, featured: [] })).toBe(5000);
  });

  it("is top + 10% when that beats top + 5", () => {
    // 10% of 80 is 8 > 5.
    expect(minimumToTakeFirst({ floorCents: 5000, positions: 3, featured: [8000] })).toBe(8800);
  });

  it("is top + 5 when 10% would be less", () => {
    // 10% of 10 is 1 < 5.
    expect(minimumToTakeFirst({ floorCents: 500, positions: 3, featured: [1000] })).toBe(1500);
  });

  it("rounds up to a whole unit and never sits below the floor", () => {
    // 10% of 55 is 5.50 -> 60.50 -> 61.
    expect(minimumToTakeFirst({ floorCents: 5000, positions: 3, featured: [5500] })).toBe(6100);
    expect(minimumToTakeFirst({ floorCents: 9000, featured: [1000], positions: 3 })).toBe(9000);
  });
});

describe("minimumToEnter", () => {
  it("is the floor while a position is still free", () => {
    expect(minimumToEnter({ floorCents: 5000, positions: 3, featured: [9000, 8000] })).toBe(5000);
  });

  it("is the lowest featured bid + 1 once the spot is full", () => {
    expect(minimumToEnter({ floorCents: 5000, positions: 3, featured: [9000, 8000, 7000] })).toBe(7100);
  });

  it("never sits below the floor", () => {
    expect(minimumToEnter({ floorCents: 5000, positions: 3, featured: [3000, 2000, 1000] })).toBe(5000);
  });
});

describe("validateBid", () => {
  const full = { floorCents: 5000, positions: 3, featured: [10_000, 8000, 6000] };

  it("refuses anything that is not whole units", () => {
    expect(validateBid(5050, full)).toEqual({ ok: false, reason: "not-whole-units", minimum: 6100 });
  });

  it("refuses a bid below the floor of an empty spot", () => {
    const empty = { floorCents: 5000, positions: 3, featured: [] };
    expect(validateBid(4900, empty)).toEqual({ ok: false, reason: "below-floor", minimum: 5000 });
    expect(validateBid(5000, empty)).toEqual({ ok: true });
  });

  it("refuses a bid that would not enter a full spot", () => {
    expect(validateBid(6000, full)).toEqual({ ok: false, reason: "below-entry", minimum: 6100 });
    expect(validateBid(6100, full)).toEqual({ ok: true });
  });

  it("lets a bid into positions 2-3 without the first-place increment", () => {
    // 9000 beats the 8000 and 6000 but not the 10000: position 2.
    expect(validateBid(9000, full)).toEqual({ ok: true });
  });

  it("lets a bid equal to the top through — the tie goes to the earlier bid, so it is not taking first", () => {
    expect(validateBid(10_000, full)).toEqual({ ok: true });
  });

  it("requires the first-place increment to beat the top bid", () => {
    // max(10000 + 10%, 10000 + 5) = 11000.
    expect(validateBid(10_500, full)).toEqual({ ok: false, reason: "below-first", minimum: 11_000 });
    expect(validateBid(11_000, full)).toEqual({ ok: true });
  });

  it("applies the first-place increment even when a position is free", () => {
    const oneIn = { floorCents: 5000, positions: 3, featured: [6000] };
    expect(validateBid(6200, oneIn)).toEqual({ ok: false, reason: "below-first", minimum: 6600 });
    expect(validateBid(5000, oneIn)).toEqual({ ok: true });
  });
});

describe("validateLower", () => {
  it("allows any whole-unit amount at or above the floor", () => {
    expect(validateLower(5000, 5000)).toEqual({ ok: true });
    expect(validateLower(4900, 5000)).toEqual({ ok: false, reason: "below-floor", minimum: 5000 });
    expect(validateLower(5050, 5000)).toEqual({ ok: false, reason: "not-whole-units", minimum: 5000 });
  });
});

describe("quantityFor", () => {
  it("sums only the bids that are active AND featured, in whole units", () => {
    expect(
      quantityFor([
        { amountCents: 5000, status: "active", position: 1 },
        { amountCents: 7000, status: "active", position: 3 },
        { amountCents: 9000, status: "active", position: null },
        { amountCents: 9000, status: "outbid", position: null },
        { amountCents: 9000, status: "pending", position: null },
        { amountCents: 9000, status: "cancelled", position: 1 },
      ]),
    ).toBe(120);
  });

  it("is zero with nothing featured", () => {
    expect(quantityFor([])).toBe(0);
  });
});
