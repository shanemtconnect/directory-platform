import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAnswers, type Answers } from "./questions";
import { SEED_HEADERS, REQUIRED_SEED_HEADERS, scaffoldSeed } from "./scaffold-seed";

const BASE = {
  name: "Studio Finder",
  shortName: "SF",
  domain: "studiofinder.co.uk",
  tagline: "Find a room to record in",
  legalEntity: "Studio Finder Ltd",
  supportEmail: "hello@studiofinder.co.uk",
  entitySingular: "studio",
  entityPlural: "studios",
  entityVerb: "list",
  entityOwnerNoun: "studio owner",
  country: "GB",
  schemaListingType: "LocalBusiness",
  niche: "studios",
};

function answers(overrides: Record<string, unknown> = {}): Answers {
  const result = buildAnswers({ ...BASE, ...overrides });
  if ("errors" in result) throw new Error(result.errors.join("; "));
  return result.answers;
}

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clone-seed-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function rows(path: string): string[] {
  return readFileSync(path, "utf8").trim().split("\n");
}

describe("SEED_HEADERS", () => {
  it("matches the columns scripts/seed.ts reads", () => {
    expect(SEED_HEADERS.cities).toEqual(["name", "region", "country", "lat", "lng", "population"]);
    expect(SEED_HEADERS.categories).toEqual(["name", "singular", "plural", "sort_order"]);
    expect(SEED_HEADERS.listings).toEqual([
      "name", "city", "region", "category", "address_line1", "postcode", "phone", "website",
    ]);
  });

  it("knows the loader reads a listing's region to tell two same-named cities apart", () => {
    // scripts/seed.ts keys a listing's city on name AND region. Without this
    // column a wizard-copied file with two Springfields was warned about as
    // "ignored" and every listing in the second one was silently skipped.
    expect(SEED_HEADERS.listings).toContain("region");
  });

  it("names the columns the loader cannot do without", () => {
    expect(REQUIRED_SEED_HEADERS.listings).toEqual(["name", "city", "category"]);
    expect(REQUIRED_SEED_HEADERS.cities).toEqual(["name"]);
  });
});

describe("scaffoldSeed — template", () => {
  it("writes the three CSVs the seed loader expects", () => {
    const report = scaffoldSeed(answers(), { targetDir: dir });
    expect(report.dir).toBe(join(dir, "seeds", "studios"));
    for (const file of ["cities", "categories", "listings"] as const) {
      const path = join(report.dir, `${file}.csv`);
      expect(existsSync(path)).toBe(true);
      expect(rows(path)[0]).toBe(SEED_HEADERS[file].join(","));
    }
  });

  it("writes three example rows per file", () => {
    const report = scaffoldSeed(answers(), { targetDir: dir });
    for (const file of ["cities", "categories", "listings"] as const) {
      expect(rows(join(report.dir, `${file}.csv`))).toHaveLength(4);
    }
  });

  it("builds the example rows from the entity nouns, leaving no placeholder behind", () => {
    const report = scaffoldSeed(answers(), { targetDir: dir });
    const categories = readFileSync(join(report.dir, "categories.csv"), "utf8");
    const listings = readFileSync(join(report.dir, "listings.csv"), "utf8");
    expect(categories).toContain("Studios");
    expect(categories).toContain("studios");
    expect(listings).toContain("Studio");
    for (const text of [categories, listings]) {
      expect(text).not.toContain("{{");
    }
  });

  it("uses the country's reserved phone number and example postcode", () => {
    const gb = readFileSync(
      join(scaffoldSeed(answers(), { targetDir: dir }).dir, "listings.csv"),
      "utf8",
    );
    expect(gb).toContain("01632 960000");
    expect(gb).toContain("LS1 4DY");

    const usDir = mkdtempSync(join(tmpdir(), "clone-seed-us-"));
    const us = readFileSync(
      join(
        scaffoldSeed(answers({ country: "US", currency: "USD", locale: "en-US" }), {
          targetDir: usDir,
        }).dir,
        "listings.csv",
      ),
      "utf8",
    );
    expect(us).toContain("90210");
    expect(us).toContain("(555) 010-0000");
    rmSync(usDir, { recursive: true, force: true });
  });

  it("writes nothing in dry-run mode", () => {
    const report = scaffoldSeed(answers(), { targetDir: dir, dryRun: true });
    expect(report.files).toHaveLength(3);
    expect(existsSync(report.dir)).toBe(false);
  });

  it("refuses to trample seed data that is already there", () => {
    mkdirSync(join(dir, "seeds", "studios"), { recursive: true });
    writeFileSync(join(dir, "seeds", "studios", "cities.csv"), "name\nReal City\n");
    expect(() => scaffoldSeed(answers(), { targetDir: dir })).toThrow(/already exists/);
    expect(readFileSync(join(dir, "seeds", "studios", "cities.csv"), "utf8")).toContain("Real City");
  });
});

describe("scaffoldSeed — skip", () => {
  it("writes nothing at all", () => {
    const report = scaffoldSeed(answers({ seedSource: "skip" }), { targetDir: dir });
    expect(report.files).toHaveLength(0);
    expect(existsSync(join(dir, "seeds"))).toBe(false);
  });
});

describe("scaffoldSeed — csv", () => {
  function supplied(overrides: Record<string, string> = {}): Record<string, string> {
    const src = join(dir, "src");
    mkdirSync(src, { recursive: true });
    const files: Record<string, string> = {
      cities: "name,region,country\nReal City,Real Region,GB\n",
      categories: "name,singular,plural,sort_order\nReal Category,real category,real categories,0\n",
      listings: "name,city,category\nReal Listing,Real City,Real Category\n",
      ...overrides,
    };
    const paths: Record<string, string> = {};
    for (const [file, text] of Object.entries(files)) {
      const path = join(src, `${file}.csv`);
      writeFileSync(path, text);
      paths[file] = path;
    }
    return paths;
  }

  function csvAnswers(paths: Record<string, string>): Answers {
    return answers({
      seedSource: "csv",
      seedCitiesCsv: paths["cities"],
      seedCategoriesCsv: paths["categories"],
      seedListingsCsv: paths["listings"],
    });
  }

  it("copies the operator's files into seeds/<niche>/", () => {
    const report = scaffoldSeed(csvAnswers(supplied()), { targetDir: dir });
    expect(readFileSync(join(report.dir, "listings.csv"), "utf8")).toContain("Real Listing");
    expect(report.files).toHaveLength(3);
  });

  it("refuses a file missing a column the loader cannot do without", () => {
    const paths = supplied({ listings: "name,category\nReal Listing,Real Category\n" });
    expect(() => scaffoldSeed(csvAnswers(paths), { targetDir: dir })).toThrow(/city/);
  });

  it("refuses a file that is not there", () => {
    const paths = supplied();
    paths["cities"] = join(dir, "src", "missing.csv");
    expect(() => scaffoldSeed(csvAnswers(paths), { targetDir: dir })).toThrow(/missing\.csv/);
  });

  it("warns about a column the loader will ignore rather than refusing the file", () => {
    const paths = supplied({ cities: "name,nonsense\nReal City,x\n" });
    const report = scaffoldSeed(csvAnswers(paths), { targetDir: dir });
    expect(report.warnings.join("\n")).toMatch(/nonsense/);
  });

  it("does not warn about a listings region column — the loader reads it", () => {
    const paths = supplied({
      listings: "name,city,region,category\nReal Listing,Real City,Real Region,Real Category\n",
    });
    const report = scaffoldSeed(csvAnswers(paths), { targetDir: dir });
    expect(report.warnings).toEqual([]);
  });
});
