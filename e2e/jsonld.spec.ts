import { expect, test, type Page } from "@playwright/test";

const CITY = "/richmond-north-yorkshire";

/**
 * The highest-value assertion in the suite.
 *
 * No reviews exist yet. Emitting `aggregateRating` for a listing nobody has
 * rated is fabricated structured data — a Google structured-data policy
 * violation that risks a manual action across the whole domain, and it is the
 * single easiest thing for a well-meaning change to reintroduce.
 */

/** Recursively collects every object key in a parsed JSON-LD graph. */
function collectKeys(node: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(node)) {
    for (const item of node) collectKeys(item, out);
  } else if (node !== null && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      out.add(key);
      collectKeys(value, out);
    }
  }
  return out;
}

async function jsonLdBlocks(page: Page): Promise<string[]> {
  return page.$$eval('script[type="application/ld+json"]', (nodes) =>
    nodes.map((n) => n.textContent ?? ""),
  );
}

async function firstListingPath(page: Page): Promise<string> {
  await page.goto(CITY);
  const href = await page
    .locator('[data-testid="listing-grid"] > li a')
    .first()
    .getAttribute("href");
  expect(href).toBeTruthy();
  return href!;
}

test.describe("JSON-LD", () => {
  test("every block on a listing page parses as valid JSON", async ({ page }) => {
    const path = await firstListingPath(page);
    await page.goto(path);

    const blocks = await jsonLdBlocks(page);
    expect(blocks.length, "a listing page must ship JSON-LD").toBeGreaterThanOrEqual(2);

    for (const [i, raw] of blocks.entries()) {
      expect(raw.trim(), `JSON-LD block ${i} is empty`).not.toBe("");
      let parsed: unknown;
      expect(
        () => {
          parsed = JSON.parse(raw);
        },
        `JSON-LD block ${i} is not valid JSON: ${raw.slice(0, 160)}`,
      ).not.toThrow();
      expect(parsed, `JSON-LD block ${i} must be an object or array`).toBeTruthy();
      expect(typeof parsed).toBe("object");
      // A schema node with no @type is noise no consumer can use.
      const keys = collectKeys(parsed);
      expect(keys.has("@type"), `JSON-LD block ${i} has no @type`).toBe(true);
    }
  });

  test("no listing page emits aggregateRating", async ({ page }) => {
    // Check several listings, not one — a tier- or claim-status-dependent
    // branch would slip through a single-page check.
    await page.goto(CITY);
    const paths = await page.$$eval('[data-testid="listing-grid"] > li a', (as) =>
      as.map((a) => a.getAttribute("href") ?? "").filter(Boolean),
    );
    expect(paths.length).toBeGreaterThan(0);

    for (const path of paths.slice(0, 5)) {
      await page.goto(path);
      const blocks = await jsonLdBlocks(page);
      expect(blocks.length, `${path} must ship JSON-LD`).toBeGreaterThan(0);

      for (const raw of blocks) {
        const keys = collectKeys(JSON.parse(raw));
        expect(
          keys.has("aggregateRating"),
          `${path} emits aggregateRating but no reviews exist — fabricated structured data`,
        ).toBe(false);
        // The same fabrication wearing a different key.
        expect(keys.has("ratingValue"), `${path} emits ratingValue`).toBe(false);
        expect(keys.has("reviewCount"), `${path} emits reviewCount`).toBe(false);
        expect(keys.has("review"), `${path} emits review`).toBe(false);
      }
    }
  });

  test("the pillar page's JSON-LD parses and carries no ratings either", async ({ page }) => {
    await page.goto(CITY);

    const blocks = await jsonLdBlocks(page);
    expect(blocks.length, "the pillar page must ship JSON-LD").toBeGreaterThan(0);

    for (const raw of blocks) {
      const keys = collectKeys(JSON.parse(raw));
      expect(keys.has("aggregateRating"), "pillar page emits aggregateRating").toBe(false);
    }
  });
});
