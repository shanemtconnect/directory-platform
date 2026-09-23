/**
 * The seam a geocoder will one day sit behind. Today it resolves nothing.
 *
 * Auto-created cities arrive with `lat`/`lng` null, and that is deliberate:
 * inventing a coordinate is worse than having none. A null latitude makes a
 * city invisible to the distance queries and to the map, which is the correct
 * behaviour for a town we have not located yet; a guessed one puts a pin in a
 * field forty miles away and looks authoritative doing it.
 *
 * It is a typed function rather than a `// TODO` because the call site should
 * be written once, now, against the shape a real provider will return — and
 * because "why is lat null?" deserves an answer the code can hand back
 * (`reason`) instead of one a reader has to reconstruct.
 *
 * No network, no dependency, no key. `isGeocodingAvailable()` is what a caller
 * branches on; the null point is what it stores either way.
 */

export interface GeocodeQuery {
  name: string;
  /** County/state, when the submitter gave one. Never a URL segment. */
  region: string | null;
  /** ISO-3166 alpha-2, from siteConfig.country. */
  country: string;
}

export interface GeocodePoint {
  lat: number;
  lng: number;
}

export interface GeocodeOutcome {
  /** Null whenever the point is unknown — which today is always. */
  point: GeocodePoint | null;
  /** Why there is no point. Stored on the audit row, not shown to the public. */
  reason: string;
}

export const GEOCODER_UNCONFIGURED =
  "No geocoding provider is configured; coordinates are left null until one is.";

/**
 * False until a provider is wired in. Exported so callers do not have to infer
 * "unavailable" from a null result — a provider that is configured but cannot
 * find a town also returns null, and the two are not the same thing.
 */
export function isGeocodingAvailable(): boolean {
  return false;
}

/** Async now so that wiring a real provider in is not a signature change. */
export async function geocodeCity(_query: GeocodeQuery): Promise<GeocodeOutcome> {
  return { point: null, reason: GEOCODER_UNCONFIGURED };
}
