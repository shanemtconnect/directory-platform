/**
 * Types and pure helpers for the listing map.
 *
 * Nothing in this file imports React or MapLibre. That is deliberate: the map
 * itself needs a WebGL canvas and cannot run in the `node` test environment, so
 * every decision worth asserting on — which pins are plottable, what the initial
 * view is, whether a style URL can be built at all — lives here where it can be
 * tested directly.
 */

export interface Coordinates {
  lat: number;
  lng: number;
}

/**
 * What a caller hands us.
 *
 * `lat`/`lng` are nullable on purpose. Seeded and imported rows regularly have
 * no geocode yet, and a row with no geocode must be dropped rather than plotted
 * at 0,0 in the Gulf of Guinea.
 */
export interface ListingMapPin {
  id: string;
  name: string;
  lat: number | null | undefined;
  lng: number | null | undefined;
  href: string;
}

/** A pin that survived {@link plottablePins} and definitely has coordinates. */
export interface PlottedPin extends ListingMapPin {
  lat: number;
  lng: number;
}

export interface ListingMapProps {
  /** Pins to plot. Entries without coordinates are dropped, not rendered. */
  pins: readonly ListingMapPin[];
  /** Force a centre. Omit to derive one from the pins. */
  centre?: Coordinates;
  /** Only honoured alongside an explicit `centre`; otherwise the fit wins. */
  zoom?: number;
  /** Applied to the map container element. */
  className?: string;
  /** Any CSS length. The container reserves this height before the map loads. */
  height?: string;
}

/** `[west, south, east, north]` — the order MapLibre's `LngLatBoundsLike` uses. */
export type BoundingBox = [west: number, south: number, east: number, north: number];

export interface PinFeature {
  type: "Feature";
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: { id: string; name: string; href: string };
}

export interface PinFeatureCollection {
  type: "FeatureCollection";
  features: PinFeature[];
}

/**
 * How the map should open.
 *
 * `bounds` non-null means "fit to these"; null means "sit at `centre`/`zoom`".
 */
export interface MapView {
  centre: Coordinates;
  zoom: number;
  bounds: BoundingBox | null;
}

export const DEFAULT_ZOOM = 11;

/** A single pin has no extent to fit, so it gets a sensible street-level zoom. */
export const SINGLE_PIN_ZOOM = 14;

const STYLE_ENDPOINT = "https://api.maptiler.com/maps/streets-v2/style.json";

/**
 * A pin is plottable only if both coordinates are real, finite and in range.
 *
 * NaN passes `typeof x === "number"`, and a bad import can put a postcode in a
 * latitude column, so range is checked too.
 */
export function isPlottable(pin: ListingMapPin): pin is PlottedPin {
  const { lat, lng } = pin;
  return (
    typeof lat === "number" &&
    typeof lng === "number" &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  );
}

export function plottablePins(pins: readonly ListingMapPin[]): PlottedPin[] {
  return pins.filter(isPlottable);
}

export function toFeatureCollection(pins: readonly PlottedPin[]): PinFeatureCollection {
  return {
    type: "FeatureCollection",
    features: pins.map((pin) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [pin.lng, pin.lat] },
      properties: { id: pin.id, name: pin.name, href: pin.href },
    })),
  };
}

export function boundsOf(pins: readonly PlottedPin[]): BoundingBox | null {
  const first = pins[0];
  if (first === undefined) return null;

  let west = first.lng;
  let east = first.lng;
  let south = first.lat;
  let north = first.lat;

  for (const pin of pins) {
    if (pin.lng < west) west = pin.lng;
    if (pin.lng > east) east = pin.lng;
    if (pin.lat < south) south = pin.lat;
    if (pin.lat > north) north = pin.lat;
  }

  return [west, south, east, north];
}

export function centreOf(pins: readonly PlottedPin[]): Coordinates | null {
  const bounds = boundsOf(pins);
  if (bounds === null) return null;
  const [west, south, east, north] = bounds;
  return { lat: (south + north) / 2, lng: (west + east) / 2 };
}

/**
 * Decide the opening view, or `null` when there is nothing to show.
 *
 * `null` is the signal for "render no map at all" — the listing list is the
 * product, the map is decoration, and an empty map is worse than none.
 */
export function resolveView(
  pins: readonly PlottedPin[],
  centre?: Coordinates,
  zoom?: number,
): MapView | null {
  if (pins.length === 0) return null;

  if (centre !== undefined) {
    return { centre, zoom: zoom ?? DEFAULT_ZOOM, bounds: null };
  }

  const only = pins.length === 1 ? pins[0] : undefined;
  if (only !== undefined) {
    return { centre: { lat: only.lat, lng: only.lng }, zoom: zoom ?? SINGLE_PIN_ZOOM, bounds: null };
  }

  const derived = centreOf(pins);
  if (derived === null) return null;
  return { centre: derived, zoom: zoom ?? DEFAULT_ZOOM, bounds: boundsOf(pins) };
}

/**
 * Build the MapTiler style URL, or `null` when there is no key.
 *
 * Staging has no key. Returning null here is what makes the component render
 * nothing at all rather than mounting a map that will 403 on its first request.
 */
export function mapStyleUrl(key: string | null | undefined): string | null {
  if (typeof key !== "string") return null;
  const trimmed = key.trim();
  if (trimmed === "") return null;
  return `${STYLE_ENDPOINT}?key=${encodeURIComponent(trimmed)}`;
}
