import { expect, test } from "@playwright/test";

const CITY = "/richmond-north-yorkshire";

/**
 * The enquiry form is the only revenue-relevant action on the site: if it
 * silently stops accepting submissions, listing owners lose leads and nobody
 * notices for weeks.
 *
 * This test writes a real row into the `enquiries` table of the dev database
 * and bumps that listing's enquiry_count — that is the point, since a mocked
 * submission would not catch a broken server action.
 *
 * Rate limit: the action allows 5 enquiries per IP per hour (fixed window in
 * Redis). Running the whole suite more than five times inside one hour against
 * the same Redis will start failing this test with the rate-limit message —
 * that is the app behaving correctly, not a flake.
 */
test.describe("enquiry submission", () => {
  test("filling and submitting the form shows the sent confirmation", async ({ page }) => {
    await page.goto(CITY);
    await page.locator('[data-testid="listing-grid"] > li a').first().click();
    await page.waitForURL(new RegExp(`${CITY}/[a-z0-9-]+$`));

    const form = page.locator('[data-testid="enquiry-form"]');
    await expect(form).toBeVisible();

    const stamp = Date.now();
    await form.locator("#enq-name").fill("Playwright Smoke");
    await form.locator("#enq-email").fill(`e2e+${stamp}@example.com`);
    await form.locator("#enq-phone").fill("01748 000000");
    await form
      .locator("#enq-message")
      .fill(`Automated end-to-end smoke test enquiry (${stamp}). Please ignore.`);

    // The honeypot must stay empty — filling it returns a silent fake success,
    // which would make this test pass for the wrong reason.
    await expect(form.locator("#company_website")).toHaveValue("");

    await form.locator('button[type="submit"]').click();

    const sent = page.locator('[data-testid="enquiry-sent"]');
    await expect(sent, "confirmation must replace the form").toBeVisible({ timeout: 15_000 });
    await expect(sent).toContainText("Enquiry sent");

    // And the form itself is gone, so nobody double-submits.
    await expect(form).toHaveCount(0);
    await expect(page.locator('[data-testid="enquiry-error"]')).toHaveCount(0);
  });

  test("an invalid submission does not report success", async ({ page }) => {
    await page.goto(CITY);
    await page.locator('[data-testid="listing-grid"] > li a').first().click();
    await page.waitForURL(new RegExp(`${CITY}/[a-z0-9-]+$`));

    const form = page.locator('[data-testid="enquiry-form"]');
    await form.locator("#enq-name").fill("A");
    await form.locator("#enq-email").fill("someone@example.com");
    // Under the 10-character minimum the server action enforces.
    await form.locator("#enq-message").fill("too short");
    await form.locator('button[type="submit"]').click();

    // Either the browser blocks it on the minlength attribute or the server
    // action rejects it — what must never happen is a success confirmation.
    await expect(page.locator('[data-testid="enquiry-sent"]')).toHaveCount(0);
  });
});
