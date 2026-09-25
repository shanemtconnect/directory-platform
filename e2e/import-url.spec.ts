import { expect, test } from "@playwright/test";
import { withE2eDb } from "./database";
import { sideCity, uniquePhone, validPostcode } from "./fixtures";

/**
 * "Have a website? Paste the address" on /add-listing, end to end: a real
 * server-side fetch through the SSRF guard, of a page served by this app
 * (/e2e/import-fixture, demo mode only), prefilling the real form, which is
 * then submitted as a person would.
 *
 * The fixture takes the fields that must be unique per run (name, phone) and
 * the ones that must match the seed (city, region) as query parameters.
 *
 * Budgets: the import allows ten look-ups an hour per connection and the
 * submission three, so running this more than three times in an hour against
 * the same Redis fails on the submission's rate-limit message.
 */

const NAME = `Import Test Studio ${Date.now()}`;

test.afterAll(async () => {
  await withE2eDb(async (sql) => {
    const rows = await sql<{ id: string }[]>`select id from listings where name = ${NAME}`;
    for (const { id } of rows) {
      await sql`delete from slugs where entity_id = ${id}`;
      await sql`delete from audit_log where entity_id = ${id}`;
      await sql`delete from listings where id = ${id}`;
    }
  });
});

test("pasting a website prefills the form, and the prefilled form submits", async ({ page, baseURL }) => {
  const city = await sideCity();
  const phone = uniquePhone();
  const postcode = validPostcode();
  const fixture = new URL("/e2e/import-fixture", baseURL);
  fixture.search = new URLSearchParams({
    name: NAME, phone, city: city.name, region: city.region ?? "", postcode,
  }).toString();

  // The fixture page is served only by a server booted with E2E_IMPORT_FIXTURE=1
  // and demo mode on (playwright.config.ts and scripts/verify-clone.sh both do).
  // Anywhere else there is nothing to import from, so say so rather than fail.
  const probe = await page.request.get(fixture.toString());
  test.skip(probe.status() !== 200, `no import fixture at ${fixture.pathname} (status ${probe.status()}) — E2E_IMPORT_FIXTURE=1 + NEXT_PUBLIC_DEMO_MODE=true needed`);

  await page.goto("/add-listing");
  const importer = page.getByTestId("import-from-url");
  await importer.getByLabel(/Have a website\?/).fill(fixture.toString());
  await importer.getByRole("button", { name: "Fill in the form" }).click();
  await expect(page.getByTestId("import-done")).toBeVisible({ timeout: 20_000 });

  const form = page.getByTestId("submit-listing-form");
  await expect(form.locator("#sl-name")).toHaveValue(NAME);
  await expect(form.locator("#sl-phone")).toHaveValue(phone);
  await expect(form.locator("#sl-city")).toHaveValue(city.name);
  await expect(form.locator("#sl-region")).toHaveValue(city.region ?? "");
  await expect(form.locator("#sl-postcode")).toHaveValue(postcode);
  await expect(form.locator("#sl-address")).toHaveValue("4 Quay Street");
  await expect(form.locator("#sl-website")).toHaveValue("https://harbourlight.example/");
  await expect(form.locator("#sl-description")).toHaveValue(/end-to-end test page/);

  // Prefilled, not locked: the person can still change anything.
  await form.locator("#sl-address").fill("5 Quay Street");

  // What a page cannot say about itself is still the person's to fill in.
  await form.locator("#sl-category").selectOption({ index: 1 });
  await form.locator("#sl-your-name").fill("Playwright Import");
  await form.locator("#sl-your-email").fill(`e2e+import${Date.now()}@example.com`);

  await expect(form.locator("#company_website")).toHaveValue("");
  await expect(form.locator('input[name="cf-turnstile-response"]')).not.toHaveValue("", {
    timeout: 15_000,
  });
  await form.locator('button[type="submit"]').click();
  await page.waitForURL(/\/add-listing\/thanks$/, { timeout: 20_000 });

  const [row] = await withE2eDb(
    (sql) => sql<{ status: string; address_line1: string }[]>`
      select status, address_line1 from listings where name = ${NAME}`,
  );
  expect(row).toEqual({ status: "pending", address_line1: "5 Quay Street" });
});

test("a page that cannot be read gets the plain-English refusal", async ({ page }) => {
  await page.goto("/add-listing");
  const importer = page.getByTestId("import-from-url");
  // Loopback on a port that is not this server's: the guard refuses it.
  await importer.getByLabel(/Have a website\?/).fill("http://127.0.0.1:5432/");
  await importer.getByRole("button", { name: "Fill in the form" }).click();
  await expect(page.getByTestId("import-error")).toHaveText(
    "We couldn't read that page. Facebook and Google pages usually block this — fill the form in below.",
  );
});
