import { describe, it, expect } from "vitest";
import {
  DEFAULT_ZOOM,
  SINGLE_PIN_ZOOM,
  boundsOf,
  centreOf,
  isPlottable,
  mapStyleUrl,
  plottablePins,
  resolveView,
  toFeatureCollection,
  type ListingMapPin,
  type PlottedPin,
} from "./types";

/**
 * The map component itself needs a WebGL canvas, so it is not tested here. What
 * is tested is everything that decides whether a map appears at all and where it
 * points — the parts that go wrong silently in production.
 */

function pin(overrides: Partial<ListingMapPin> = {}): ListingMapPin {
  return { id: "a", name: "A", lat: 51.5, lng: -0.1, href: "/a", ...overrides };
}

function plotted(lat: number, lng: number, id = "a"): PlottedPin {
  return { id, name: id.toUpperCase(), lat, lng, href: `/${id}` };
}

describe("isPlottable", () => {
  it("accepts a real coordinate pair", () => {
    expect(isPlottable(pin())).toBe(true);
  });

  it("accepts 0,0 — it is a real place, not a missing value", () => {
    expect(isPlottable(pin({ lat: 0, lng: 0 }))).toBe(true);
  });

  it("rejects null and undefined coordinates, which seeded rows routinely have", () => {
    expect(isPlottable(pin({ lat: null }))).toBe(false);
    expect(isPlottable(pin({ lng: null }))).toBe(false);
    expect(isPlottable(pin({ lat: undefined }))).toBe(false);
    expect(isPlottable(pin({ lng: undefined }))).toBe(false);
  });

  it("rejects NaN, which slips past a typeof check", () => {
    expect(isPlottable(pin({ lat: Number.NaN }))).toBe(false);
    expect(isPlottable(pin({ lng: Number.NaN }))).toBe(false);
  });

  it("rejects out-of-range values, which is what a mis-mapped import column looks like", () => {
    expect(isPlottable(pin({ lat: 91 }))).toBe(false);
    expect(isPlottable(pin({ lat: -91 }))).toBe(false);
    expect(isPlottable(pin({ lng: 181 }))).toBe(false);
    expect(isPlottable(pin({ lng: -181 }))).toBe(false);
    expect(isPlottable(pin({ lat: Number.POSITIVE_INFINITY }))).toBe(false);
  });
});

describe("plottablePins", () => {
  it("drops the ungeocoded rows and keeps the order of the rest", () => {
    const result = plottablePins([
      pin({ id: "one" }),
      pin({ id: "two", lat: null, lng: null }),
      pin({ id: "three", lng: 0.2 }),
    ]);
    expect(result.map((p) => p.id)).toEqual(["one", "three"]);
  });

  it("returns an empty array when nothing has coordinates", () => {
    expect(plottablePins([pin({ lat: null }), pin({ lng: undefined })])).toEqual([]);
  });
});

describe("toFeatureCollection", () => {
  it("emits GeoJSON in lng,lat order — the reverse of the prop order", () => {
    const [feature] = toFeatureCollection([plotted(51.5, -0.1)]).features;
    expect(feature?.geometry.coordinates).toEqual([-0.1, 51.5]);
  });

  it("carries the href through as a property so the marker can be an anchor", () => {
    const [feature] = toFeatureCollection([plotted(51.5, -0.1, "b")]).features;
    expect(feature?.properties).toEqual({ id: "b", name: "B", href: "/b" });
  });

  it("produces a valid empty collection rather than throwing", () => {
    expect(toFeatureCollection([])).toEqual({ type: "FeatureCollection", features: [] });
  });
});

describe("boundsOf", () => {
  it("returns west, south, east, north", () => {
    expect(
      boundsOf([plotted(51.5, -0.1, "a"), plotted(53.4, -2.2, "b"), plotted(50.8, 0.3, "c")]),
    ).toEqual([-2.2, 50.8, 0.3, 53.4]);
  });

  it("degenerates to a point for a single pin", () => {
    expect(boundsOf([plotted(51.5, -0.1)])).toEqual([-0.1, 51.5, -0.1, 51.5]);
  });

  it("returns null for no pins", () => {
    expect(boundsOf([])).toBeNull();
  });
});

describe("centreOf", () => {
  it("centres on the midpoint of the extent", () => {
    expect(centreOf([plotted(50, -2, "a"), plotted(52, 2, "b")])).toEqual({ lat: 51, lng: 0 });
  });

  it("returns null for no pins", () => {
    expect(centreOf([])).toBeNull();
  });
});

describe("resolveView", () => {
  it("returns null when there is nothing to plot, so no map is rendered", () => {
    expect(resolveView([])).toBeNull();
  });

  it("honours an explicit centre and never fits bounds over it", () => {
    const view = resolveView([plotted(50, -2, "a"), plotted(52, 2, "b")], { lat: 10, lng: 20 });
    expect(view).toEqual({ centre: { lat: 10, lng: 20 }, zoom: DEFAULT_ZOOM, bounds: null });
  });

  it("honours an explicit zoom alongside an explicit centre", () => {
    expect(resolveView([plotted(50, -2)], { lat: 10, lng: 20 }, 8)?.zoom).toBe(8);
  });

  it("zooms in on a lone pin instead of fitting a zero-area box", () => {
    const view = resolveView([plotted(51.5, -0.1)]);
    expect(view).toEqual({
      centre: { lat: 51.5, lng: -0.1 },
      zoom: SINGLE_PIN_ZOOM,
      bounds: null,
    });
  });

  it("fits the extent when several pins are given", () => {
    const view = resolveView([plotted(50, -2, "a"), plotted(52, 2, "b")]);
    expect(view?.bounds).toEqual([-2, 50, 2, 52]);
    expect(view?.centre).toEqual({ lat: 51, lng: 0 });
  });
});

describe("mapStyleUrl", () => {
  it("builds the MapTiler style URL from a key", () => {
    expect(mapStyleUrl("abc123")).toBe(
      "https://api.maptiler.com/maps/streets-v2/style.json?key=abc123",
    );
  });

  it("encodes the key rather than splicing it in raw", () => {
    expect(mapStyleUrl("a b&c")).toBe(
      "https://api.maptiler.com/maps/streets-v2/style.json?key=a%20b%26c",
    );
  });

  it("returns null with no key, which is how staging renders no map at all", () => {
    expect(mapStyleUrl(undefined)).toBeNull();
    expect(mapStyleUrl(null)).toBeNull();
  });

  it("treats an empty or whitespace-only key as absent", () => {
    expect(mapStyleUrl("")).toBeNull();
    expect(mapStyleUrl("   ")).toBeNull();
  });
});
