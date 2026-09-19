import { expect, test } from "@playwright/test";
import { paginatingCity } from "./fixtures";

let CITY: string;
let CITY_NAME: string;
test.beforeAll(async () => {
  const city = await paginatingCity();
  CITY = city.path;
  CITY_NAME = city.name;
});

test.describe("listing detail", () => {
  test("clicking the first listing lands on its page with contact details and an enquiry form", async ({
    page,
  }) => {
    await page.goto(CITY);

    const firstLink = page.locator('[data-testid="listing-grid"] > li a').first();
    const name = (await firstLink.textContent())?.trim();
    expect(name, "the first card must have a name").toBeTruthy();

    await firstLink.click();
    await page.waitForURL(new RegExp(`${CITY}/[a-z0-9-]+$`));

    // The h1 is the listing we clicked, not the pillar we came from.
    const h1 = page.locator("h1");
    await expect(h1).toHaveCount(1);
    await expect(h1).toHaveText(name!);

    // Contact block: on every tier, including unclaimed listings.
    const contact = page.locator('section:has(h2#contact)');
    await expect(contact, "contact section must be visible").toBeVisible();
    await expect(contact.locator("address")).toBeVisible();
    await expect(contact.locator("address")).toContainText(new RegExp(CITY_NAME, "i"));

    // Enquiry form present, with the fields a person actually needs.
    const form = page.locator('[data-testid="enquiry-form"]');
    await expect(form).toBeVisible();
    await expect(form.locator("#enq-name")).toBeVisible();
    await expect(form.locator("#enq-email")).toBeVisible();
    await expect(form.locator("#enq-message")).toBeVisible();
    await expect(form.locator('button[type="submit"]')).toBeEnabled();

    // Breadcrumb points back at the city pillar — internal linking, both ways.
    await expect(page.locator(`nav[aria-label="Breadcrumb"] a[href="${CITY}"]`)).toBeVisible();
  });
});
