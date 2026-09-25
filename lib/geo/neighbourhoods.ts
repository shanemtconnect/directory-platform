import { siteConfig } from "@/config/site.config";
import type { SiteMode } from "@/config/types";
import { isReserved, slugify } from "@/lib/routing/slugify";

/**
 * Neighbourhoods under towns (Task 52) — the pure half: the switch, the
 * distance rule, the indexing rule and the CSV reader. Everything that
 * touches the database is in lib/db/queries/neighbourhoods.ts.
 */

/* ------------------------------------------------------------------ switch */

export const NEIGHBOURHOODS_ENV_SWITCH = "NEIGHBOURHOODS_ENABLED";

interface NeighbourhoodConfig {
  siteMode: SiteMode;
  geo: { neighbourhoods: { enabled: boolean } };
}

/**
 * Whether the module is on, resolved the same way the sponsor rails are:
 * `NEIGHBOURHOODS_ENABLED=true|false` wins over the config, anything else
 * defers to it — so a staging build of a clone whose config is still off can
 * be reviewed, and the e2e suite can prove the page without a config edit.
 *
 * Never on for local-multi-vertical, whatever the switch says: that mode's
 * `areas` rows are its own top-level places, and a city-area route on it
 * would give the same row two meanings.
 */
export function neighbourhoodsEnabled(
  config: NeighbourhoodConfig = siteConfig,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (config.siteMode !== "niche-national") return false;
  const raw = (env[NEIGHBOURHOODS_ENV_SWITCH] ?? "").trim().toLowerCase();
  if (raw === "false") return false;
  if (raw === "true") return true;
  return config.geo.neighbourhoods.enabled;
}

/* ---------------------------------------------------------------- distance */

export interface Point { lat: number; lng: number }

const EARTH_RADIUS_KM = 6371.0088;
const rad = (deg: number): number => (deg * Math.PI) / 180;

/** Great-circle distance (haversine). Plenty for a few kilometres inside one town. */
export function distanceKm(a: Point, b: Point): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

export interface Centroid {
  id: string;
  slug: string;
  lat: number | null;
  lng: number | null;
  radiusKm: number | null;
}

/**
 * The neighbourhood a point belongs to: the nearest centroid among those
 * whose OWN radius reaches it, or null when none does. An exact tie goes to
 * the lower slug, so the nightly run never flips a listing back and forth
 * between two equally near neighbourhoods. A neighbourhood with no centroid
 * or no radius takes nothing.
 */
export function nearestNeighbourhood(point: Point, candidates: readonly Centroid[]): string | null {
  let best: { id: string; slug: string; d: number } | null = null;
  for (const c of candidates) {
    if (c.lat === null || c.lng === null || c.radiusKm === null) continue;
    const d = distanceKm(point, { lat: c.lat, lng: c.lng });
    if (d > c.radiusKm) continue;
    if (best === null || d < best.d || (d === best.d && c.slug < best.slug)) {
      best = { id: c.id, slug: c.slug, d };
    }
  }
  return best?.id ?? null;
}

/* ---------------------------------------------------------------- indexing */

/**
 * A neighbourhood page earns indexing on its own published count, and on
 * nothing else — it has no intro copy of its own, and inheriting the town's
 * flag is how a page with one listing would be indexed on the back of a town
 * with thirty.
 */
export function decideNeighbourhoodIndexability(
  listingCount: number,
  minListings: number = siteConfig.geo.neighbourhoods.minListings,
): { listingCount: number; isIndexable: boolean } {
  return { listingCount, isIndexable: listingCount >= minListings };
}

/* --------------------------------------------------------------------- CSV */

export const NEIGHBOURHOOD_CSV_COLUMNS = ["city_slug", "name", "slug", "lat", "lng", "radius_km"] as const;

export interface NeighbourhoodCsvRow {
  /** 1-based, counting the header, so it matches what the admin sees in an editor. */
  line: number;
  citySlug: string;
  name: string;
  slug: string;
  lat: number;
  lng: number;
  radiusKm: number;
}

export interface CsvProblem { line: number; message: string }

/** Most rows one upload may carry — a town has tens of neighbourhoods, not thousands. */
export const MAX_NEIGHBOURHOOD_ROWS = 2000;

/**
 * RFC 4180 fields: quoted cells may hold commas, doubled quotes and line
 * breaks. Hand-rolled because this is the only CSV the app reads at runtime
 * and it does not justify a dependency.
 */
function csvRecords(text: string): { line: number; cells: string[] }[] {
  const out: { line: number; cells: string[] }[] = [];
  let cells: string[] = [];
  let cell = "";
  let quoted = false;
  let line = 1;
  let startLine = 1;
  const push = () => {
    cells.push(cell);
    cell = "";
  };
  const end = () => {
    push();
    if (!(cells.length === 1 && cells[0]!.trim() === "")) out.push({ line: startLine, cells });
    cells = [];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else {
        if (ch === "\n") line++;
        cell += ch;
      }
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ",") push();
    else if (ch === "\r") continue;
    else if (ch === "\n") { end(); line++; startLine = line; }
    else cell += ch;
  }
  if (cell !== "" || cells.length > 0) end();
  return out;
}

function number(raw: string): number | null {
  if (raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Reads an upload into rows the importer can write, and a problem per row it
 * cannot. One bad row never sinks the file: the rest are imported and the
 * admin sees exactly which lines were skipped and why. City existence and
 * slug collisions are the importer's to check — they need the database.
 */
export function parseNeighbourhoodCsv(
  text: string,
  defaultRadiusKm: number = siteConfig.geo.neighbourhoods.defaultRadiusKm,
): { rows: NeighbourhoodCsvRow[]; errors: CsvProblem[] } {
  const records = csvRecords(text.replace(/^﻿/, ""));
  const [head, ...body] = records;
  const expected = NEIGHBOURHOOD_CSV_COLUMNS.join(",");
  const got = head?.cells.map((c) => c.trim().toLowerCase()).join(",");
  if (got !== expected) {
    return { rows: [], errors: [{ line: 1, message: `The first line must be exactly: ${expected}` }] };
  }
  if (body.length > MAX_NEIGHBOURHOOD_ROWS) {
    return {
      rows: [],
      errors: [{ line: 1, message: `One file may carry at most ${MAX_NEIGHBOURHOOD_ROWS} rows; split it.` }],
    };
  }

  const rows: NeighbourhoodCsvRow[] = [];
  const errors: CsvProblem[] = [];
  for (const { line, cells } of body) {
    const [citySlug = "", name = "", slug = "", lat = "", lng = "", radius = ""] = cells.map((c) => c.trim());
    const fail = (message: string) => errors.push({ line, message });

    if (citySlug === "") { fail("The city_slug is empty."); continue; }
    if (name === "") { fail("The name is empty."); continue; }
    const finalSlug = slugify(slug === "" ? name : slug);
    if (finalSlug === "") { fail(`Nothing in "${slug || name}" can be a URL slug.`); continue; }
    if (isReserved(finalSlug)) { fail(`"${finalSlug}" is a reserved word and cannot be a neighbourhood slug.`); continue; }

    const latN = number(lat);
    if (latN === null || latN < -90 || latN > 90) { fail(`Latitude "${lat}" is not a number between -90 and 90.`); continue; }
    const lngN = number(lng);
    if (lngN === null || lngN < -180 || lngN > 180) { fail(`Longitude "${lng}" is not a number between -180 and 180.`); continue; }
    const radiusN = radius === "" ? defaultRadiusKm : number(radius);
    if (radiusN === null || radiusN <= 0) { fail(`Radius "${radius}" is not a positive number of kilometres.`); continue; }

    rows.push({ line, citySlug: citySlug.toLowerCase(), name, slug: finalSlug, lat: latN, lng: lngN, radiusKm: radiusN });
  }
  return { rows, errors };
}
