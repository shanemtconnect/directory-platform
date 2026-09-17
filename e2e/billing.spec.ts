import { expect, test } from "@playwright/test";

/**
 * Checkout, end to end, with no PayPal involved.
 *
 * There are no PayPal credentials in this environment — deliberately, since a
 * smoke suite that could create a real subscription would create one on every
 * run. So what is proved here is everything up to the point money would change
 * hands: the pricing page links somewhere real, the checkout route exists and
 * is gated, and somebody who has not claimed anything is refused rather than
 * shown a form they cannot use.
 *
 * The signed-in half creates a throwaway account through the real signup form.
 * That account owns no listing, which is exactly the case being tested.
 */

const PAID_TIERS = ["essential", "premium"] as const;

test.describe("pricing call to action", () => {
  test("every paid plan links to its own checkout URL", async ({ page }) => {
    await page.goto("/pricing");

    for (const tier of PAID_TIERS) {
      const card = page.locator(`[data-testid="plan-${tier}"]`);
      await expect(card).toBeVisible();
      const cta = card.locator('[data-testid="plan-checkout-link"]');
      await expect(cta).toHaveAttribute("href", `/checkout/${tier}/annual`);
    }
  });

  test("the monthly page links to the monthly checkout", async ({ page }) => {
    await page.goto("/pricing/monthly");
    await expect(
      page.locator('[data-testid="plan-premium"] [data-testid="plan-checkout-link"]'),
    ).toHaveAttribute("href", "/checkout/premium/monthly");
  });

  test("the free plan sends people to the submission form, not to checkout", async ({ page }) => {
    await page.goto("/pricing");
    const free = page.locator('[data-testid="plan-free"] [data-testid="plan-cta"] a');
    await expect(free).toHaveAttribute("href", "/add-listing");
  });
});

test.describe("checkout routing", () => {
  test("an anonymous visitor is sent to sign in, with a way back", async ({ page }) => {
    await page.goto("/checkout/premium/annual");
    await page.waitForURL(/\/login\?next=/);
    expect(page.url()).toContain(encodeURIComponent("/checkout/premium/annual"));
  });

  test("a plan that does not exist is a 404, not a blank checkout", async ({ page }) => {
    const response = await page.goto("/checkout/platinum/annual");
    expect(response?.status()).toBe(404);
  });

  test("an interval that does not exist is a 404 too", async ({ page }) => {
    const response = await page.goto("/checkout/premium/weekly");
    expect(response?.status()).toBe(404);
  });

  test("the free plan has no checkout page", async ({ page }) => {
    const response = await page.goto("/checkout/free/annual");
    expect(response?.status()).toBe(404);
  });

  test("checkout is never indexed", async ({ page }) => {
    await page.goto("/checkout/cancelled");
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
      "content",
      /noindex/,
    );
  });
});

test.describe("signed in without a claimed listing", () => {
  test("checkout refuses, and the billing page says there is no plan", async ({ page }) => {
    const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
    const email = `e2e-billing+${stamp}@example.com`;

    await page.goto("/signup");
    const form = page.locator('[data-testid="signup-form"]');
    await expect(form).toBeVisible();
    await form.locator("#name").fill("Playwright Billing");
    await form.locator("#email").fill(email);
    await form.locator("#password").fill(`pw-${stamp}-longenough`);
    await form.locator('button[type="submit"]').click();
    await page.waitForURL(/\/account$/, { timeout: 30_000 });

    // No listing id at all.
    await page.goto("/checkout/premium/annual");
    await expect(page.locator('[data-testid="checkout-refused"]')).toBeVisible();
    await expect(page.locator('[data-testid="checkout-form"]')).toHaveCount(0);

    // A listing that exists, but is somebody else's — the non-owner case. The
    // id is well-formed so the refusal is an ownership decision rather than a
    // parse failure.
    await page.goto("/checkout/premium/annual?listing=00000000-0000-4000-8000-000000000001");
    await expect(page.locator('[data-testid="checkout-refused"]')).toBeVisible();

    await page.goto("/account/billing");
    await expect(page.locator('[data-testid="no-subscriptions"]')).toBeVisible();
    await expect(page.locator('[data-testid="invoices-empty"]')).toBeVisible();
  });
});
