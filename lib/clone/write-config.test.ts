import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAnswers, type Answers } from "./questions";
import { renderSiteConfig, writeSiteConfig, SITE_CONFIG_PATH, TEMPLATE_CONFIG_MARKER } from "./write-config";
import { ConfigError } from "@/config/validate";

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
};

function answers(overrides: Record<string, unknown> = {}): Answers {
  const result = buildAnswers({ ...BASE, ...overrides });
  if ("errors" in result) throw new Error(result.errors.join("; "));
  return result.answers;
}

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clone-config-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("renderSiteConfig", () => {
  it("emits the pay-per-lead section with the documented defaults and the flag off", () => {
    const source = renderSiteConfig(answers());
    expect(source).toContain("    leadMarketplace: false,");
    expect(source).toMatch(/leads: \{\n    floor: 25,\n    packs: \[50, 100, 300\],\n    halfPriceAfterDays: 7,\n    deleteAfterDays: 30,\n    refundWindowDays: 7,\n  \}/);
  });

  it("renders a config that closes with the satisfies assertion the build relies on", () => {
    const source = renderSiteConfig(answers());
    expect(source).toContain('import type { CustomField, SiteConfig } from "./types";');
    expect(source).toContain("export const siteConfig = {");
    expect(source).toContain("} as const satisfies SiteConfig;");
  });

  it("exports everything the shipped config exports, so components that import them compile", () => {
    // components/shortlist/fields.ts imports `cardFields`; a rendered config
    // without the widened accessors is a clone that fails `pnpm typecheck`.
    const exportsOf = (source: string): string[] =>
      [...source.matchAll(/^export (?:const|function|type|interface) (\w+)/gm)]
        .map((m) => m[1]!)
        .sort();
    const shipped = readFileSync(join(__dirname, "..", "..", SITE_CONFIG_PATH), "utf8");
    expect(exportsOf(renderSiteConfig(answers()))).toEqual(exportsOf(shipped));
    expect(exportsOf(shipped)).toContain("cardFields");
  });

  it("imports the CustomField type the accessors are declared with", () => {
    expect(renderSiteConfig(answers())).toContain('import type { CustomField, SiteConfig } from "./types";');
  });

  it("writes the entity nouns the operator gave, not the ones the template shipped with", () => {
    const source = renderSiteConfig(answers());
    expect(source).toContain('singular: "studio"');
    expect(source).toContain('Plural: "Studios"');
    expect(source).toContain('ownerNoun: "studio owner"');
  });

  it("builds the tier marketing copy from the entity nouns", () => {
    const source = renderSiteConfig(answers());
    expect(source).toContain("Full Studio description displayed");
  });

  it("keeps the annual = 10 x monthly relationship the pricing copy claims", () => {
    const source = renderSiteConfig(answers({ essentialPriceMonthly: 12, essentialPriceAnnual: 120 }));
    expect(source).toContain("priceMonthly: 12");
    expect(source).toContain("priceAnnual: 120");
  });

  it("renders an unlimited image cap as null", () => {
    expect(renderSiteConfig(answers())).toContain("maxImages: null");
  });

  it("escapes a value that would otherwise break out of its string literal", () => {
    const source = renderSiteConfig(answers({ name: 'Studio "Finder"' }));
    expect(source).toContain('name: "Studio \\"Finder\\""');
  });

  it("renders custom fields, including select options and the tier gate", () => {
    const source = renderSiteConfig(
      answers({
        customFields: [
          { key: "room_count", label: "Rooms", type: "number", searchable: true, showInCard: true },
          { key: "price_from", label: "Prices from", type: "currency", tier: "essential" },
          { key: "live_room", label: "Live room", type: "select", options: ["yes", "no"] },
        ],
      }),
    );
    expect(source).toContain('{ key: "room_count", label: "Rooms", type: "number", searchable: true, showInCard: true }');
    expect(source).toContain('tier: "essential"');
    expect(source).toContain('options: ["yes", "no"]');
  });

  it("renders every feature flag so a new flag cannot be silently absent", () => {
    const source = renderSiteConfig(answers({ feature_costGuides: true }));
    expect(source).toContain("costGuides: true");
    expect(source).toContain("jobBoard: false");
  });
});

describe("writeSiteConfig", () => {
  it("writes the file and reports where it went", () => {
    const result = writeSiteConfig(answers(), { targetDir: dir });
    expect(result.path).toBe(join(dir, SITE_CONFIG_PATH));
    expect(readFileSync(result.path, "utf8")).toContain("export const siteConfig");
  });

  it("writes nothing at all in dry-run mode", () => {
    const result = writeSiteConfig(answers(), { targetDir: dir, dryRun: true });
    expect(result.source).toContain("export const siteConfig");
    expect(existsSync(join(dir, SITE_CONFIG_PATH))).toBe(false);
  });

  it("refuses a feature combination the build would reject, and writes nothing", () => {
    expect(() =>
      writeSiteConfig(answers({ feature_awards: true, feature_reviews: false }), { targetDir: dir }),
    ).toThrow(ConfigError);
    expect(existsSync(join(dir, SITE_CONFIG_PATH))).toBe(false);
  });

  it("refuses a country and currency that do not belong together", () => {
    expect(() => writeSiteConfig(answers({ currency: "USD" }), { targetDir: dir })).toThrow(
      /currency "USD" is unusual/,
    );
    expect(existsSync(join(dir, SITE_CONFIG_PATH))).toBe(false);
  });

  it("refuses a placeholder legal entity, because a production build refuses it too", () => {
    expect(() => writeSiteConfig(answers({ legalEntity: "TBC" }), { targetDir: dir })).toThrow(
      /legal entity/i,
    );
  });

  it("allows the placeholder only when the operator asked for it explicitly", () => {
    const result = writeSiteConfig(answers({ legalEntity: "TBC" }), {
      targetDir: dir,
      allowPlaceholders: true,
    });
    expect(readFileSync(result.path, "utf8")).toContain('legalEntity: "TBC"');
  });

  it("refuses to overwrite a config that is already there", () => {
    mkdirSync(join(dir, "config"), { recursive: true });
    writeFileSync(join(dir, SITE_CONFIG_PATH), "// someone's work\n");
    expect(() => writeSiteConfig(answers(), { targetDir: dir })).toThrow(/already exists/);
    expect(readFileSync(join(dir, SITE_CONFIG_PATH), "utf8")).toContain("someone's work");
  });

  it("replaces the template's own demo config without being told to", () => {
    // A fresh checkout always carries the demo niche's config, so the first
    // run of the wizard — the only run most clones ever make — used to fail on
    // "already exists" and send the operator back with --overwrite.
    mkdirSync(join(dir, "config"), { recursive: true });
    writeFileSync(
      join(dir, SITE_CONFIG_PATH),
      `// ${TEMPLATE_CONFIG_MARKER}\nexport const siteConfig = { name: "Demo" };\n`,
    );
    const result = writeSiteConfig(answers(), { targetDir: dir });
    expect(result.written).toBe(true);
    expect(readFileSync(result.path, "utf8")).not.toContain("Demo");
  });

  it("does not mark what it writes as the template, so a clone's config is protected", () => {
    const result = writeSiteConfig(answers(), { targetDir: dir });
    expect(readFileSync(result.path, "utf8")).not.toContain(TEMPLATE_CONFIG_MARKER);
    expect(() => writeSiteConfig(answers(), { targetDir: dir })).toThrow(/already exists/);
  });

  it("the shipped config carries the marker", () => {
    const shipped = readFileSync(join(__dirname, "..", "..", SITE_CONFIG_PATH), "utf8");
    expect(shipped).toContain(TEMPLATE_CONFIG_MARKER);
  });

  it("overwrites when told to, so re-running the wizard is possible", () => {
    mkdirSync(join(dir, "config"), { recursive: true });
    writeFileSync(join(dir, SITE_CONFIG_PATH), "// someone's work\n");
    const result = writeSiteConfig(answers(), { targetDir: dir, overwrite: true });
    expect(readFileSync(result.path, "utf8")).toContain("export const siteConfig");
  });
});

describe("renderSiteConfig — sponsor rails (Task 43)", () => {
  it("renders the ads block from the wizard answer, off by default", () => {
    const source = renderSiteConfig(answers());
    expect(source).toContain("  ads: {\n    enabled: false,");
    expect(source).toContain('listingDetail: "unpaid-only"');
    expect(source).toContain('home: "never"');
  });

  it("turns the rails on when the wizard was told to", () => {
    expect(renderSiteConfig(answers({ adsEnabled: "yes" }))).toContain("  ads: {\n    enabled: true,");
  });
});
