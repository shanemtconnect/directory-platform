import { expect, test } from "@playwright/test";
import { randomBytes } from "node:crypto";
import postgres from "postgres";

const CITY = "/richmond-north-yorkshire";

/**
 * The whole review pipeline, end to end, against a production build and a real
 * database: write → confirm the address → the review is on the page and the
 * listing's average has moved.
 *
 * It has to be an e2e test rather than a unit test because the part most
 * likely to break silently is the seam — a server action that validates, a
 * route handler that writes and redirects, and an ISR-cached page that has to
 * be revalidated or the reviewer follows their own link and sees nothing.
 *
 * The token is read straight out of `review_invites` because there is no mail
 * provider in this environment. That is the same link the worker would send.
 *
 * Rate limit: the action allows 3 reviews per IP per hour. Running the suite
 * repeatedly inside one hour against the same Redis will start failing this
 * with the rate-limit message — the app behaving correctly, not a flake.
 */

const FLAGS_OFF = process.env.SITE_FLAGS_OVERRIDE === "off";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://directory:directory@localhost:5433/directory_dev";

/** Letters only: a digit run or a URL in the body would be held for moderation. */
function marker(): string {
  return randomBytes(8).toString("hex").replace(/\d/g, "x");
}

async function tokenFor(email: string): Promise<string> {
  const sql = postgres(DATABASE_URL, { max: 1 });
  try {
    const rows = await sql<{ token: string }[]>`
      select token from review_invites where sent_to = ${email} order by created_at desc limit 1
    `;
    const token = rows[0]?.token;
    if (!token) throw new Error(`No review_invites row for ${email}`);
    return token;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function openFirstListing(page: import("@playwright/test").Page): Promise<void> {
  await page.goto(CITY);
  await page.locator('[data-testid="listing-grid"] > li a').first().click();
  await page.waitForURL(new RegExp(`${CITY}/[a-z0-9-]+$`));
}

test.describe("reviews", () => {
  test.skip(FLAGS_OFF, "the reviews module is off in this build");

  test("write, confirm, and the review is on the page", async ({ page }) => {
    test.slow();

    await openFirstListing(page);
    const listingUrl = new URL(page.url()).pathname;

    // The listing page always offers the route, whether or not it has reviews.
    const leaveReview = page.locator('a[href^="/leave-review/"]').first();
    await expect(leaveReview).toBeVisible();
    await leaveReview.click();
    await page.waitForURL(/\/leave-review\/[0-9a-f-]{36}$/);

    const email = `e2e-review+${randomBytes(6).toString("hex")}@example.com`;
    const body =
      `Used them through this site and the whole thing was straightforward, ` +
      `from the first reply through to the final invoice. Marker ${marker()}.`;

    const form = page.locator('[data-testid="review-form"]');
    await expect(form).toBeVisible();
    await form.locator('input[name="rating"][value="5"]').check();
    await form.locator("#rev-title").fill("Straightforward from start to finish");
    await form.locator("#rev-body").fill(body);
    await form.locator("#rev-name").fill("Playwright Smoke");
    await form.locator("#rev-email").fill(email);

    // The honeypot must stay empty — filling it returns a silent fake success.
    await expect(form.locator("#company_website")).toHaveValue("");

    await expect(form.locator('input[name="cf-turnstile-response"]'))
      .not.toHaveValue("", { timeout: 15_000 });

    await form.locator('button[type="submit"]').click();

    const sent = page.locator('[data-testid="review-sent"]');
    await expect(sent, "the form must confirm and say nothing is live yet").toBeVisible({
      timeout: 15_000,
    });
    await expect(sent).toContainText("Check your email");
    await expect(page.locator('[data-testid="review-error"]')).toHaveCount(0);

    // Nothing is published until the link is clicked.
    await page.goto(`${listingUrl}/reviews`);
    await expect(page.getByText(body)).toHaveCount(0);

    const token = await tokenFor(email);
    await page.goto(`/review/verify/${token}`);

    // The link lands on the reviews page with the review on it.
    await expect(page).toHaveURL(new RegExp(`${listingUrl}/reviews$`));
    await expect(async () => {
      await page.reload();
      await expect(page.locator('[data-testid="review-list"]')).toContainText(body);
    }).toPass({ timeout: 30_000 });

    // And the listing page now carries the average it did not have before.
    await page.goto(listingUrl);
    await expect(page.locator('[data-testid="rating-summary"]')).toBeVisible();
    await expect(page.locator('[data-testid="rating-summary"]')).toContainText("out of 5");

    // The rating is in the markup only because it is on the page.
    const jsonLd = await page.locator('script[type="application/ld+json"]').allTextContents();
    const business = jsonLd
      .map((raw) => JSON.parse(raw) as Record<string, unknown>)
      .find((node) => typeof node["aggregateRating"] === "object");
    expect(business, "aggregateRating must ship once the rating is rendered").toBeTruthy();
  });

  test("a review with nothing in it is not accepted", async ({ page }) => {
    await openFirstListing(page);
    await page.locator('a[href^="/leave-review/"]').first().click();
    await page.waitForURL(/\/leave-review\/[0-9a-f-]{36}$/);

    const form = page.locator('[data-testid="review-form"]');
    await form.locator("#rev-name").fill("Playwright Smoke");
    await form.locator("#rev-email").fill("someone@example.com");
    await form.locator('button[type="submit"]').click();

    // Either the browser blocks it on `required` or the action rejects it.
    // What must never happen is a confirmation.
    await expect(page.locator('[data-testid="review-sent"]')).toHaveCount(0);
  });

  test("an unissued token is a 404, not a published review", async ({ page }) => {
    const response = await page.goto(`/review/verify/${randomBytes(24).toString("base64url")}`);
    expect(response?.status()).toBe(404);
  });
});

test.describe("reviews, flag off", () => {
  test.skip(!FLAGS_OFF, "this build has the reviews module on");

  test("every review route is a 404 and nothing links to one", async ({ page }) => {
    await openFirstListing(page);
    const listingUrl = new URL(page.url()).pathname;

    await expect(page.locator('[data-testid="reviews-summary"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="reviews-empty"]')).toHaveCount(0);
    await expect(page.locator('a[href^="/leave-review/"]')).toHaveCount(0);

    expect((await page.goto(`${listingUrl}/reviews`))?.status()).toBe(404);
    expect((await page.goto("/leave-review/00000000-0000-4000-8000-000000000000"))?.status())
      .toBe(404);
    expect((await page.goto("/review/verify/anything"))?.status()).toBe(404);
  });
});
