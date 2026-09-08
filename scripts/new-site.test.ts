import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, copyFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs, nextSteps, CliError } from "./new-site";
import { SEED_HEADERS } from "@/lib/clone/scaffold-seed";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const TSX = join(REPO, "node_modules", ".bin", "tsx");
const WIZARD = join(REPO, "scripts", "new-site.ts");

/** A national directory of one kind of thing, in the UK. */
const GB_ANSWERS = {
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
  siteMode: "niche-national",
  schemaListingType: "LocalBusiness",
  customFields: [
    { key: "room_count", label: "Rooms", type: "number", searchable: true, showInCard: true },
    { key: "price_from", label: "Prices from", type: "currency", tier: "essential" },
  ],
  niche: "studios",
  seedSource: "template",
};

/** One town, many kinds of business, in the US. */
const US_ANSWERS = {
  name: "Fairhaven Local",
  shortName: "Fairhaven",
  domain: "fairhavenlocal.com",
  tagline: "Every trade in town",
  legalEntity: "Fairhaven Local LLC",
  supportEmail: "hello@fairhavenlocal.com",
  entitySingular: "business",
  entityPlural: "businesses",
  entitySingularCapitalised: "Business",
  entityPluralCapitalised: "Businesses",
  entityVerb: "list",
  entityOwnerNoun: "business owner",
  country: "US",
  siteMode: "local-multi-vertical",
  schemaListingType: "LocalBusiness",
  feature_reviews: true,
  feature_awards: true,
  niche: "fairhaven",
  seedSource: "template",
};

let dir = "";
let target = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "new-site-"));
  target = join(dir, "site");
  mkdirSync(target, { recursive: true });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function answersFile(answers: Record<string, unknown>): string {
  const path = join(dir, "answers.json");
  writeFileSync(path, JSON.stringify(answers, null, 2));
  return path;
}

function runWizard(answers: Record<string, unknown>, extra: readonly string[] = []) {
  return spawnSync(
    TSX,
    [WIZARD, "--answers", answersFile(answers), "--target", target, ...extra],
    { cwd: REPO, encoding: "utf8" },
  );
}

function headerOf(path: string): string[] {
  return readFileSync(path, "utf8").split("\n")[0]!.split(",");
}

describe("parseArgs", () => {
  it("defaults to an interactive run against the current directory", () => {
    const opts = parseArgs([]);
    expect(opts.answersPath).toBeUndefined();
    expect(opts.dryRun).toBe(false);
    expect(opts.keepDemo).toBe(false);
    expect(opts.allowPlaceholders).toBe(false);
  });

  it("reads the flags the runbook documents", () => {
    const opts = parseArgs([
      "--answers", "a.json", "--dry-run", "--keep-demo", "--allow-placeholders",
      "--overwrite", "--target", "/tmp/site", "--site-env", "production",
    ]);
    expect(opts.answersPath).toBe("a.json");
    expect(opts.dryRun).toBe(true);
    expect(opts.keepDemo).toBe(true);
    expect(opts.allowPlaceholders).toBe(true);
    expect(opts.overwrite).toBe(true);
    expect(opts.targetDir).toBe("/tmp/site");
    expect(opts.siteEnv).toBe("production");
  });

  it("refuses a flag it does not know rather than ignoring a typo", () => {
    expect(() => parseArgs(["--dryrun"])).toThrow(CliError);
  });

  it("refuses a flag that was given no value", () => {
    expect(() => parseArgs(["--answers"])).toThrow(/--answers/);
  });
});

describe("nextSteps", () => {
  it("prints the exact commands, in order, with the seed name filled in", () => {
    const steps = nextSteps({ niche: "studios", allowedPlaceholders: false }).join("\n");
    expect(steps).toContain("corepack pnpm db:up");
    expect(steps).toContain("corepack pnpm db:migrate");
    expect(steps).toContain("corepack pnpm seed studios");
    expect(steps).toContain("corepack pnpm dev");
    expect(steps.indexOf("db:up")).toBeLessThan(steps.indexOf("db:migrate"));
    expect(steps.indexOf("db:migrate")).toBeLessThan(steps.indexOf("seed studios"));
    expect(steps.indexOf("seed studios")).toBeLessThan(steps.indexOf("pnpm dev"));
  });

  it("says the legal entity is still a placeholder when it was let through", () => {
    const steps = nextSteps({ niche: "x", allowedPlaceholders: true }).join("\n");
    expect(steps).toMatch(/legalEntity/);
  });
});

describe("the wizard, run non-interactively", () => {
  it("configures a national directory from a GB answers file", () => {
    const run = runWizard(GB_ANSWERS);
    expect(run.status).toBe(0);

    const config = readFileSync(join(target, "config", "site.config.ts"), "utf8");
    expect(config).toContain('singular: "studio"');
    expect(config).toContain('locale: "en-GB"');
    expect(config).toContain('currency: "GBP"');
    expect(config).toContain('regionLabel: "county"');
    expect(config).toContain('siteMode: "niche-national"');
    expect(config).toContain('key: "room_count"');
  });

  it("writes seed CSVs whose headers are the ones the seed loader reads", () => {
    expect(runWizard(GB_ANSWERS).status).toBe(0);
    for (const file of ["cities", "categories", "listings"] as const) {
      expect(headerOf(join(target, "seeds", "studios", `${file}.csv`)))
        .toEqual([...SEED_HEADERS[file]]);
    }
  });

  it("writes a .env carrying the site URL and a staging flag", () => {
    expect(runWizard(GB_ANSWERS).status).toBe(0);
    const env = readFileSync(join(target, ".env"), "utf8");
    expect(env).toContain("NEXT_PUBLIC_SITE_URL=https://studiofinder.co.uk");
    expect(env).toContain("SITE_ENV=staging");
    expect(env).toContain("DATABASE_URL=");
  });

  it("prints the next commands", () => {
    const run = runWizard(GB_ANSWERS);
    expect(run.stdout).toContain("corepack pnpm seed studios");
    expect(run.stdout).toContain("corepack pnpm dev");
  });

  it("configures a local multi-vertical directory from a US answers file", () => {
    const run = runWizard(US_ANSWERS);
    expect(run.status).toBe(0);
    const config = readFileSync(join(target, "config", "site.config.ts"), "utf8");
    expect(config).toContain('siteMode: "local-multi-vertical"');
    expect(config).toContain('locale: "en-US"');
    expect(config).toContain('currency: "USD"');
    expect(config).toContain('regionLabel: "state"');
    expect(config).toContain("awards: true");
    expect(readFileSync(join(target, "seeds", "fairhaven", "listings.csv"), "utf8"))
      .toContain("90210");
  });

  it("generates a config that imports and passes the build's own validators", () => {
    expect(runWizard(GB_ANSWERS).status).toBe(0);
    const configUrl = pathToFileURL(join(target, "config", "site.config.ts")).href;
    const validateUrl = pathToFileURL(join(REPO, "config", "validate.ts")).href;
    const probe = join(dir, "probe.mts");
    writeFileSync(
      probe,
      [
        `const { siteConfig } = await import(${JSON.stringify(configUrl)});`,
        `const v = await import(${JSON.stringify(validateUrl)});`,
        `v.validateFeatureDependencies(siteConfig.features);`,
        `v.validateCountry(siteConfig);`,
        `console.log(JSON.stringify({ name: siteConfig.name, mode: siteConfig.siteMode }));`,
      ].join("\n"),
    );
    const run = spawnSync(TSX, [probe], { cwd: REPO, encoding: "utf8" });
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout.trim())).toEqual({
      name: "Studio Finder",
      mode: "niche-national",
    });
  });

  it("generates a config that type-checks under the project's strict settings", () => {
    expect(runWizard(GB_ANSWERS).status).toBe(0);
    copyFileSync(join(REPO, "config", "types.ts"), join(target, "config", "types.ts"));
    const run = spawnSync(
      join(REPO, "node_modules", ".bin", "tsc"),
      [
        "--noEmit", "--strict", "--skipLibCheck", "--ignoreConfig",
        "--target", "es2022", "--module", "esnext", "--moduleResolution", "bundler",
        join(target, "config", "site.config.ts"),
      ],
      { cwd: REPO, encoding: "utf8" },
    );
    expect(run.stdout.trim()).toBe("");
    expect(run.status).toBe(0);
  }, 30_000);

  it("refuses a country and currency that contradict each other, and writes nothing", () => {
    const run = runWizard({ ...GB_ANSWERS, currency: "USD" });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(/currency "USD" is unusual/);
    expect(existsSync(join(target, "config", "site.config.ts"))).toBe(false);
  });

  it("refuses a placeholder legal entity unless it is allowed explicitly", () => {
    const refused = runWizard({ ...GB_ANSWERS, legalEntity: "TBC" });
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toMatch(/--allow-placeholders/);

    const allowed = runWizard({ ...GB_ANSWERS, legalEntity: "TBC" }, ["--allow-placeholders"]);
    expect(allowed.status).toBe(0);
    expect(allowed.stdout).toMatch(/legalEntity/);
  });

  it("reports every bad answer at once instead of one per run", () => {
    const run = runWizard({ ...GB_ANSWERS, domain: "https://x.test", supportEmail: "nope" });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(/domain/);
    expect(run.stderr).toMatch(/supportEmail/);
  });

  it("writes nothing in dry-run mode but prints the config it would write", () => {
    const run = runWizard(GB_ANSWERS, ["--dry-run"]);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("export const siteConfig = {");
    expect(existsSync(join(target, "config", "site.config.ts"))).toBe(false);
    expect(existsSync(join(target, "seeds"))).toBe(false);
    expect(existsSync(join(target, ".env"))).toBe(false);
  });

  it("clears the template's demo blog posts, and keeps them when asked to", () => {
    const demo = join(target, "content", "blog", "demo");
    mkdirSync(demo, { recursive: true });
    writeFileSync(join(demo, "post.mdx"), "---\ntitle: Demo\n---\n");
    expect(runWizard(GB_ANSWERS).status).toBe(0);
    expect(existsSync(demo)).toBe(false);

    rmSync(join(target, "config"), { recursive: true, force: true });
    rmSync(join(target, "seeds"), { recursive: true, force: true });
    mkdirSync(demo, { recursive: true });
    writeFileSync(join(demo, "post.mdx"), "---\ntitle: Demo\n---\n");
    expect(runWizard(GB_ANSWERS, ["--keep-demo"]).status).toBe(0);
    expect(existsSync(join(demo, "post.mdx"))).toBe(true);
  });

  it("refuses to overwrite an existing config unless told to", () => {
    expect(runWizard(GB_ANSWERS).status).toBe(0);
    const again = runWizard(GB_ANSWERS);
    expect(again.status).not.toBe(0);
    expect(again.stderr).toMatch(/already exists/);
    expect(runWizard(GB_ANSWERS, ["--overwrite"]).status).toBe(0);
  });
});
