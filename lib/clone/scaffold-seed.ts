import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { countryProfile } from "@/lib/geo/countries";
import { capitalise, type Answers } from "./questions";

export type SeedFile = "cities" | "categories" | "listings";
export const SEED_FILES: readonly SeedFile[] = ["cities", "categories", "listings"];

/** Exactly what `scripts/seed.ts` reads. Changing one means changing both. */
export const SEED_HEADERS: Record<SeedFile, readonly string[]> = {
  cities: ["name", "region", "country", "lat", "lng", "population"],
  categories: ["name", "singular", "plural", "sort_order"],
  // `region` is how the loader tells two cities of the same name apart — a
  // listing is keyed on city name AND region, exactly as cities.csv is.
  listings: ["name", "city", "region", "category", "address_line1", "postcode", "phone", "website"],
};

/** Without these the loader cannot place a row at all, so a file missing one is refused. */
export const REQUIRED_SEED_HEADERS: Record<SeedFile, readonly string[]> = {
  cities: ["name"],
  categories: ["name"],
  listings: ["name", "city", "category"],
};

/** Ships in the repo so the example rows can be edited without editing code. */
const TEMPLATE_DIR = fileURLToPath(new URL("../../seeds/_template/", import.meta.url));

export class SeedScaffoldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SeedScaffoldError";
  }
}

export interface ScaffoldOptions {
  readonly targetDir: string;
  readonly dryRun?: boolean;
  readonly overwrite?: boolean;
}

export interface ScaffoldedFile {
  readonly file: SeedFile;
  readonly path: string;
  readonly source: "template" | "copied";
  readonly rows: number;
}

export interface ScaffoldReport {
  readonly dir: string;
  readonly files: readonly ScaffoldedFile[];
  readonly warnings: readonly string[];
}

function placeholders(a: Answers): Record<string, string> {
  const profile = countryProfile(a.country);
  return {
    singular: a.entitySingular,
    Singular: a.entitySingularCapitalised,
    plural: a.entityPlural,
    Plural: a.entityPluralCapitalised,
    country: a.country,
    regionLabel: a.regionLabel,
    RegionLabel: capitalise(a.regionLabel),
    postcode: profile.postcodeExample,
    phone: profile.reservedPhoneExample,
  };
}

function fill(text: string, values: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (whole, key: string) => values[key] ?? whole);
}

function headerOf(text: string, path: string): readonly string[] {
  const first = text.split("\n")[0];
  if (first === undefined || first.trim().length === 0) {
    throw new SeedScaffoldError(`${path} is empty — the first line must be the header row.`);
  }
  return first.replace(/^﻿/, "").split(",").map((h) => h.trim());
}

function countRows(text: string): number {
  return text.trim().split("\n").length - 1;
}

function readSupplied(file: SeedFile, path: string, warnings: string[]): string {
  if (path.trim().length === 0) {
    throw new SeedScaffoldError(`No path given for the ${file} CSV.`);
  }
  if (!existsSync(path)) {
    throw new SeedScaffoldError(`Cannot read the ${file} CSV: ${path} does not exist.`);
  }
  const text = readFileSync(path, "utf8");
  const header = headerOf(text, path);
  const missing = REQUIRED_SEED_HEADERS[file].filter((h) => !header.includes(h));
  if (missing.length > 0) {
    throw new SeedScaffoldError(
      `${path} is missing the column${missing.length > 1 ? "s" : ""} ${missing.join(", ")}. ` +
        `The ${file} loader needs ${REQUIRED_SEED_HEADERS[file].join(", ")}; ` +
        `it also reads ${SEED_HEADERS[file].join(", ")}.`,
    );
  }
  const unknown = header.filter((h) => h.length > 0 && !SEED_HEADERS[file].includes(h));
  if (unknown.length > 0) {
    warnings.push(
      `${path}: the seed loader ignores the column${unknown.length > 1 ? "s" : ""} ` +
        `${unknown.join(", ")}. Import them later with the CSV importer if you need them.`,
    );
  }
  return text;
}

/**
 * Writes `seeds/<niche>/{cities,categories,listings}.csv`.
 *
 * `template` fills the shipped example rows from the answers, so the operator
 * edits real-looking rows rather than inventing a schema. `csv` validates the
 * operator's own files against the loader's columns and copies them — a header
 * typo is caught here rather than as a silent skip during the seed run.
 */
export function scaffoldSeed(a: Answers, opts: ScaffoldOptions): ScaffoldReport {
  const dir = join(opts.targetDir, "seeds", a.niche);
  const warnings: string[] = [];

  if (a.seedSource === "skip") return { dir, files: [], warnings };

  const suppliedPaths: Record<SeedFile, string> = {
    cities: a.seedCitiesCsv,
    categories: a.seedCategoriesCsv,
    listings: a.seedListingsCsv,
  };
  const values = placeholders(a);

  const contents = SEED_FILES.map((file) => {
    const text =
      a.seedSource === "csv"
        ? readSupplied(file, suppliedPaths[file], warnings)
        : fill(readFileSync(join(TEMPLATE_DIR, `${file}.csv`), "utf8"), values);
    return { file, text };
  });

  const files: ScaffoldedFile[] = contents.map(({ file, text }) => ({
    file,
    path: join(dir, `${file}.csv`),
    source: a.seedSource === "csv" ? "copied" : "template",
    rows: countRows(text),
  }));

  if (opts.dryRun === true) return { dir, files, warnings };

  const clash = files.find((f) => existsSync(f.path));
  if (clash !== undefined && opts.overwrite !== true) {
    throw new SeedScaffoldError(
      `${clash.path} already exists. Re-run with --overwrite to replace the seed CSVs, ` +
        `after checking there is nothing in them you meant to keep.`,
    );
  }

  mkdirSync(dir, { recursive: true });
  for (const [i, { text }] of contents.entries()) {
    const target = files[i];
    if (target === undefined) continue;
    writeFileSync(target.path, text, "utf8");
  }

  return { dir, files, warnings };
}
