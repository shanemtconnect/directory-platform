import { describe, it, expect } from "vitest";
import {
  distanceKm,
  nearestNeighbourhood,
  neighbourhoodsEnabled,
  decideNeighbourhoodIndexability,
  parseNeighbourhoodCsv,
  NEIGHBOURHOOD_CSV_COLUMNS,
  MAX_RADIUS_KM,
} from "./neighbourhoods";

/** Headingley-ish and Leeds city centre: about 3 km apart. */
const CENTRE = { lat: 53.7997, lng: -1.5492 };

/** A point `km` due north of `from` — 1° of latitude is ~111.19 km. */
const north = (from: { lat: number; lng: number }, km: number) => ({
  lat: from.lat + km / 111.195, lng: from.lng,
});

describe("distanceKm", () => {
  it("is zero at the same point and symmetric", () => {
    expect(distanceKm(CENTRE, CENTRE)).toBe(0);
    const p = north(CENTRE, 3);
    expect(distanceKm(CENTRE, p)).toBeCloseTo(distanceKm(p, CENTRE), 9);
  });

  it("measures a known north–south distance to within a few metres", () => {
    expect(distanceKm(CENTRE, north(CENTRE, 3))).toBeCloseTo(3, 2);
  });
});

describe("nearestNeighbourhood", () => {
  const a = { id: "a", slug: "headingley", lat: CENTRE.lat, lng: CENTRE.lng, radiusKm: 2 };

  it("assigns a point inside the radius", () => {
    expect(nearestNeighbourhood(north(CENTRE, 1.5), [a])).toBe("a");
  });

  it("assigns nothing to a point outside every radius", () => {
    expect(nearestNeighbourhood(north(CENTRE, 2.5), [a])).toBeNull();
  });

  it("takes the NEAREST centroid when two radii overlap", () => {
    const b = { id: "b", slug: "hyde-park", ...north(CENTRE, 2), radiusKm: 2 };
    expect(nearestNeighbourhood(north(CENTRE, 0.5), [b, a])).toBe("a");
    expect(nearestNeighbourhood(north(CENTRE, 1.5), [a, b])).toBe("b");
  });

  it("measures each centroid against its OWN radius, not the nearest one's", () => {
    // `wide` is further away but reaches; `tight` is nearer and does not.
    const tight = { id: "tight", slug: "tight", ...north(CENTRE, 1), radiusKm: 0.5 };
    const wide = { id: "wide", slug: "wide", ...north(CENTRE, 3), radiusKm: 5 };
    expect(nearestNeighbourhood(north(CENTRE, 1.8), [tight, wide])).toBe("wide");
  });

  it("breaks an exact tie on the slug, so every run gives the same answer", () => {
    const east = { id: "east", slug: "zeta", lat: CENTRE.lat, lng: CENTRE.lng + 0.01, radiusKm: 5 };
    const west = { id: "west", slug: "alpha", lat: CENTRE.lat, lng: CENTRE.lng - 0.01, radiusKm: 5 };
    expect(nearestNeighbourhood(CENTRE, [east, west])).toBe("west");
    expect(nearestNeighbourhood(CENTRE, [west, east])).toBe("west");
  });

  it("counts a point exactly on the radius as inside", () => {
    const edge = north(CENTRE, 2);
    const exact = { ...a, radiusKm: distanceKm(CENTRE, edge) };
    expect(nearestNeighbourhood(edge, [exact])).toBe("a");
  });

  it("ignores a neighbourhood with no centroid or no radius", () => {
    expect(nearestNeighbourhood(CENTRE, [{ ...a, lat: null }])).toBeNull();
    expect(nearestNeighbourhood(CENTRE, [{ ...a, radiusKm: null }])).toBeNull();
  });
});

describe("neighbourhoodsEnabled", () => {
  const on = { siteMode: "niche-national" as const, geo: { neighbourhoods: { enabled: true, minListings: 5, defaultRadiusKm: 2 } } };
  const off = { ...on, geo: { neighbourhoods: { ...on.geo.neighbourhoods, enabled: false } } };

  it("follows the config when the environment says nothing", () => {
    expect(neighbourhoodsEnabled(on, {})).toBe(true);
    expect(neighbourhoodsEnabled(off, {})).toBe(false);
  });

  it("NEIGHBOURHOODS_ENABLED turns it on over a config that has it off, and off over one that has it on", () => {
    expect(neighbourhoodsEnabled(off, { NEIGHBOURHOODS_ENABLED: "true" })).toBe(true);
    expect(neighbourhoodsEnabled(on, { NEIGHBOURHOODS_ENABLED: "false" })).toBe(false);
    expect(neighbourhoodsEnabled(on, { NEIGHBOURHOODS_ENABLED: "maybe" })).toBe(true);
  });

  it("is never on for a local-multi-vertical site, whatever the switch says", () => {
    const lmv = { ...on, siteMode: "local-multi-vertical" as const };
    expect(neighbourhoodsEnabled(lmv, {})).toBe(false);
    expect(neighbourhoodsEnabled(lmv, { NEIGHBOURHOODS_ENABLED: "true" })).toBe(false);
  });
});

describe("decideNeighbourhoodIndexability", () => {
  it("is indexable at the threshold and not one below it", () => {
    expect(decideNeighbourhoodIndexability(5, 5)).toEqual({ listingCount: 5, isIndexable: true });
    expect(decideNeighbourhoodIndexability(4, 5)).toEqual({ listingCount: 4, isIndexable: false });
    expect(decideNeighbourhoodIndexability(0, 1)).toEqual({ listingCount: 0, isIndexable: false });
  });
});

describe("parseNeighbourhoodCsv", () => {
  const header = NEIGHBOURHOOD_CSV_COLUMNS.join(",");

  it("reads the six columns, with the default radius for an empty cell", () => {
    const out = parseNeighbourhoodCsv(
      `${header}\nleeds,Headingley,headingley,53.8190,-1.5800,1.5\nleeds,Hyde Park,,53.8100,-1.5700,\n`,
      2,
    );
    expect(out.errors).toEqual([]);
    expect(out.rows).toEqual([
      { line: 2, citySlug: "leeds", name: "Headingley", slug: "headingley", lat: 53.819, lng: -1.58, radiusKm: 1.5 },
      // An empty slug is derived from the name.
      { line: 3, citySlug: "leeds", name: "Hyde Park", slug: "hyde-park", lat: 53.81, lng: -1.57, radiusKm: 2 },
    ]);
  });

  it("accepts quoted cells with commas and quotes in them, and CRLF line ends", () => {
    const out = parseNeighbourhoodCsv(`${header}\r\nleeds,"Chapel Allerton, North","chapel-allerton",53.83,-1.53,2\r\n`, 2);
    expect(out.errors).toEqual([]);
    expect(out.rows[0]!.name).toBe("Chapel Allerton, North");
  });

  it("reports a bad latitude or longitude by line and skips only that row", () => {
    const out = parseNeighbourhoodCsv(
      `${header}\nleeds,North,north,91,-1.5,2\nleeds,West,west,53.8,abc,2\nleeds,Ok,ok,53.8,-1.5,2\n`,
      2,
    );
    expect(out.rows.map((r) => r.slug)).toEqual(["ok"]);
    expect(out.errors).toEqual([
      { line: 2, message: expect.stringMatching(/latitude/i) },
      { line: 3, message: expect.stringMatching(/longitude/i) },
    ]);
  });

  it("reports a missing name, a bad radius and a reserved slug", () => {
    const out = parseNeighbourhoodCsv(
      `${header}\nleeds,,x,53.8,-1.5,2\nleeds,Far,far,53.8,-1.5,-1\nleeds,Page,page,53.8,-1.5,2\n`,
      2,
    );
    expect(out.rows).toEqual([]);
    expect(out.errors.map((e) => e.line)).toEqual([2, 3, 4]);
    expect(out.errors[1]!.message).toMatch(/radius/i);
    expect(out.errors[2]!.message).toMatch(/reserved/i);
  });

  it("refuses a file whose header is not the six columns", () => {
    const out = parseNeighbourhoodCsv("city,name\nleeds,Headingley\n", 2);
    expect(out.rows).toEqual([]);
    expect(out.errors).toEqual([{ line: 1, message: expect.stringContaining(header) }]);
  });

  it("caps the radius at 25 km — a typo must not swallow the whole town", () => {
    expect(MAX_RADIUS_KM).toBe(25);
    const out = parseNeighbourhoodCsv(`${header}\nleeds,Edge,edge,53.8,-1.5,25\nleeds,Huge,huge,53.8,-1.5,200\n`, 2);
    expect(out.rows.map((r) => r.slug)).toEqual(["edge"]);
    expect(out.errors).toEqual([{ line: 3, message: expect.stringMatching(/25/) }]);
  });

  it("reads a file saved with a UTF-8 byte-order mark", () => {
    const out = parseNeighbourhoodCsv(`\uFEFF${header}\nleeds,A,a,53.8,-1.5,2\n`, 2);
    expect(out.errors).toEqual([]);
    expect(out.rows).toHaveLength(1);
  });

  it("ignores blank lines", () => {
    const out = parseNeighbourhoodCsv(`${header}\n\nleeds,A,a,53.8,-1.5,2\n\n`, 2);
    expect(out.rows).toHaveLength(1);
    expect(out.errors).toEqual([]);
  });
});
