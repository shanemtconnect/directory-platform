import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import postgres from "postgres";

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
 * One test leaves that account with nothing claimed — the refusal. The other
 * hands it a DRAFT listing straight in the database (draft, so it touches no
 * public page or city count) and expects the picker, then the checkout page
 * itself once a listing is chosen. Billing has no credentials here, so the
 * step after ownership is the "not set up" panel, which is the proof that
 * ownership passed.
 */

const PAID_TIERS = ["essential", "premium"] as const;

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://directory:directory@localhost:5433/directory_dev";

async function signUp(page: Page): Promise<string> {
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
  return email;
}

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
    await signUp(page);

    // No listing id at all, and nothing claimed: there is nothing to pick.
    await page.goto("/checkout/premium/annual");
    await expect(page.locator('[data-testid="checkout-refused"]')).toBeVisible();
    await expect(page.locator('[data-testid="checkout-listing-picker"]')).toHaveCount(0);
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

test.describe("signed in with a claimed listing", () => {
  test("the pricing link leads to a picker, and the pick leads to checkout", async ({ page }) => {
    const email = await signUp(page);
    const sql = postgres(DATABASE_URL, { max: 1 });
    const listingId = randomUUID();

    try {
      // The profile row is normally created on the user's first owner action;
      // here it is created directly so the listing can be handed over.
      const [u] = await sql<{ id: string }[]>`select id from "user" where email = ${email}`;
      expect(u).toBeDefined();
      await sql`insert into profiles (user_id) values (${u!.id}) on conflict (user_id) do nothing`;
      const [p] = await sql<{ id: string }[]>`select id from profiles where user_id = ${u!.id}`;
      const [scaffold] = await sql<{ city_id: string; vertical_id: string; category_id: string }[]>`
        select c.id as city_id, cat.vertical_id, cat.id as category_id
        from categories cat
        cross join (select id from cities order by id limit 1) c
        order by cat.id
        limit 1`;
      expect(scaffold).toBeDefined();
      // Draft, so no public page, sitemap entry or city count changes.
      await sql`insert into listings
        (id, name, slug, city_id, vertical_id, primary_category_id, status, claim_status, owner_id, source)
        values (${listingId}, ${"Playwright Claimed"}, ${`e2e-claimed-${listingId.slice(0, 8)}`},
          ${scaffold!.city_id}, ${scaffold!.vertical_id}, ${scaffold!.category_id},
          'draft', 'claimed', ${p!.id}, 'seed')`;

      // Same URL the pricing card links to: no listing on it.
      await page.goto("/checkout/premium/annual");
      const picker = page.locator('[data-testid="checkout-listing-picker"]');
      await expect(picker).toBeVisible();
      await expect(page.locator('[data-testid="checkout-refused"]')).toHaveCount(0);
      const option = picker.locator('[data-testid="checkout-listing-option"]');
      await expect(option).toHaveCount(1);
      await expect(option).toHaveText("Playwright Claimed");
      await expect(option).toHaveAttribute("href", `/checkout/premium/annual?listing=${listingId}`);

      // Choosing it gets past ownership. With no PayPal credentials in this
      // environment the next panel is "not set up" — which is only ever
      // rendered AFTER the owner check has passed.
      await option.click();
      await page.waitForURL(/\?listing=/);
      await expect(page.locator('[data-testid="billing-unavailable"]')).toBeVisible();
      await expect(page.locator('[data-testid="checkout-refused"]')).toHaveCount(0);

      // A stranger's well-formed id on the same URL is still refused.
      await page.goto("/checkout/premium/annual?listing=00000000-0000-4000-8000-000000000001");
      await expect(page.locator('[data-testid="checkout-refused"]')).toBeVisible();
    } finally {
      await sql`delete from listings where id = ${listingId}`;
      await sql.end({ timeout: 5 });
    }
  });
});
