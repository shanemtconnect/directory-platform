import { expect, test, type Page } from "@playwright/test";
import postgres from "postgres";
import { E2E_DATABASE_URL } from "./database";

const CITY = "/richmond-north-yorkshire";

/**
 * The same database the server under test writes to. Asserting on the
 * confirmation page alone would pass for an action that renders a thanks page
 * and files nothing, which is precisely the regression worth catching here.
 */
// The same database the server under test runs on — never directory_dev.
const DATABASE_URL = E2E_DATABASE_URL;

async function rowExists(sql: string, value: string): Promise<boolean> {
  const client = postgres(DATABASE_URL, { max: 1 });
  try {
    const rows = await client.unsafe(sql, [value]);
    return rows.length > 0;
  } finally {
    await client.end({ timeout: 5 });
  }
}

/**
 * The two routes /trust and /data-sources promise in writing.
 *
 * Both tests write a real row — into `reports` and `removal_requests` of the
 * dev database — because that is the whole point: a mocked submission would
 * not catch a server action that silently stopped filing anything, and a
 * removal route that quietly drops requests is the one failure on this site
 * with a regulator at the end of it.
 *
 * Rate limits: reports are 5 per IP per hour and removal requests 3, both
 * fixed windows in Redis. Running the whole suite repeatedly inside one hour
 * against the same Redis will eventually fail these with the rate-limit
 * message — that is the app behaving correctly, not a flake.
 */

/** Opens the first listing in the city and returns the link the visitor sees. */
async function openFirstListing(page: Page): Promise<void> {
  await page.goto(CITY);
  await page.locator('[data-testid="listing-grid"] > li a').first().click();
  await page.waitForURL(new RegExp(`${CITY}/[a-z0-9-]+$`));
}

async function waitForTurnstile(page: Page): Promise<void> {
  // The token is issued asynchronously. Submitting before it lands sends an
  // empty one, which the action rejects rather than waving through.
  await expect(page.locator('input[name="cf-turnstile-response"]'))
    .not.toHaveValue("", { timeout: 15_000 });
}

test.describe("reporting a listing", () => {
  test("the listing page links to a report form that files the report", async ({ page }) => {
    await openFirstListing(page);

    const links = page.locator('[data-testid="correction-links"]');
    await expect(links).toBeVisible();
    // The advertised route, not a mailto:.
    await expect(links.getByRole("link", { name: "Report incorrect information" }))
      .toHaveAttribute("href", /^\/report\/[0-9a-f-]{36}$/);

    await links.getByRole("link", { name: "Report incorrect information" }).click();
    await page.waitForURL(/\/report\/[0-9a-f-]{36}$/);

    const form = page.locator('[data-testid="report-form"]');
    await expect(form).toBeVisible();

    const stamp = Date.now();
    await form.locator("#rp-closed").check();
    await form.locator("#rp-detail").fill(`Automated end-to-end smoke test report (${stamp}). Please ignore.`);
    await form.locator("#rp-email").fill(`e2e+report${stamp}@example.com`);

    // Filling the honeypot would return a silent fake success, which would
    // make this test pass for the wrong reason.
    await expect(form.locator("#company_website")).toHaveValue("");
    await waitForTurnstile(page);

    await form.locator('button[type="submit"]').click();

    await page.waitForURL(/\/report\/[0-9a-f-]{36}\/thanks$/, { timeout: 15_000 });
    await expect(page.locator('[data-testid="report-thanks"]')).toBeVisible();
    await expect(page.locator('[data-testid="report-error"]')).toHaveCount(0);

    // The row, not just the page that says there is one.
    expect(
      await rowExists("select 1 from reports where reporter_email = $1 and status = 'open'", `e2e+report${stamp}@example.com`),
      "the report must be in the database, not only on the screen",
    ).toBe(true);
  });

  test("a report giving no detail for 'something else' does not report success", async ({ page }) => {
    await openFirstListing(page);
    const href = await page
      .locator('[data-testid="correction-links"]')
      .getByRole("link", { name: "Report incorrect information" })
      .getAttribute("href");
    await page.goto(href!);

    const form = page.locator('[data-testid="report-form"]');
    await form.locator("#rp-other").check();
    await waitForTurnstile(page);
    await form.locator('button[type="submit"]').click();

    // The server action rejects it; what must never happen is a thanks page.
    await expect(page).not.toHaveURL(/\/thanks$/);
    await expect(form.getByRole("alert").first()).toBeVisible({ timeout: 15_000 });
  });
});

test.describe("requesting removal", () => {
  test("the listing page links to a removal form that files the request", async ({ page }) => {
    await openFirstListing(page);

    const links = page.locator('[data-testid="correction-links"]');
    await expect(links.getByRole("link", { name: "Request removal" }))
      .toHaveAttribute("href", /^\/remove\/[0-9a-f-]{36}$/);

    await links.getByRole("link", { name: "Request removal" }).click();
    await page.waitForURL(/\/remove\/[0-9a-f-]{36}$/);

    // The SLA the site promises in writing is on the page a person acts on.
    await expect(page.getByRole("main")).toContainText("5 working days");

    const form = page.locator('[data-testid="removal-form"]');
    await expect(form).toBeVisible();

    const stamp = Date.now();
    await form.locator("#rm-name").fill("Playwright Smoke");
    await form.locator("#rm-email").fill(`e2e+removal${stamp}@example.com`);
    await form.locator("#rm-subject").check();
    await form.locator("#rm-reason").fill(`Automated end-to-end smoke test (${stamp}). Please ignore.`);

    await expect(form.locator("#company_website")).toHaveValue("");
    await waitForTurnstile(page);

    await form.locator('button[type="submit"]').click();

    await page.waitForURL(/\/remove\/[0-9a-f-]{36}\/thanks$/, { timeout: 15_000 });
    const thanks = page.locator('[data-testid="removal-thanks"]');
    await expect(thanks).toBeVisible();
    await expect(thanks).toContainText("5 working days");
    await expect(page.locator('[data-testid="removal-error"]')).toHaveCount(0);

    // The row, with the deadline the page promised on it.
    expect(
      await rowExists(
        "select 1 from removal_requests where requester_email = $1 and status = 'open' and due_at is not null",
        `e2e+removal${stamp}@example.com`,
      ),
      "the removal request must be in the database with a due date",
    ).toBe(true);
  });

  test("a listing id that is not ours is a 404, not a form", async ({ page }) => {
    const response = await page.goto("/remove/00000000-0000-4000-8000-000000000000");
    expect(response?.status()).toBe(404);
    await expect(page.locator('[data-testid="removal-form"]')).toHaveCount(0);
  });
});
