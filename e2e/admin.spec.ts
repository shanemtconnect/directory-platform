import { expect, test, type Page } from "@playwright/test";
import postgres from "postgres";
import { E2E_DATABASE_URL } from "./database";
import { quietCity, uniquePhone, validPostcode } from "./fixtures";

/**
 * The moderation round trip: a stranger submits, an admin approves, the public
 * sees it.
 *
 * This is the only path in the product where something an unauthenticated
 * person typed becomes a page on the open web, so it is worth a test that goes
 * all the way through the real server rather than four unit tests that each
 * stop short of the join.
 *
 * It writes to the dev database on purpose — a new account, a listing, an audit
 * row — exactly as e2e/enquiry.spec.ts writes an enquiry. A mocked approval
 * would not catch a broken server action, which is the whole risk here.
 *
 * Rate limit: /add-listing allows 3 submissions per IP per hour, and this suite
 * spends exactly one of them (see `seedPendingListing`). A fourth run inside
 * the same hour against the same Redis fails on the rate-limit message — that
 * is the app behaving correctly, not a flake.
 */

// The same database the server under test runs on — never directory_dev.
const DATABASE_URL = E2E_DATABASE_URL;

/**
 * A town with a region and as few listings as possible, so an approved
 * submission is on the first page of it without depending on where the daily
 * shuffle puts it among however many the seed holds. Filled in `beforeAll`
 * from `quietCity()`, which reads the live counts rather than naming a town.
 */
let TOWN: { region: string; city: string; slug: string };

test.beforeAll(async () => {
  const c = await quietCity();
  if (c.region === null) {
    throw new Error(`quietCity() returned ${c.slug} with no region — admin.spec.ts needs one.`);
  }
  TOWN = { region: c.region, city: c.name, slug: c.slug };
});

const PASSWORD = "not-a-real-password";

function unique(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
}

async function signUp(page: Page, email: string): Promise<void> {
  await page.goto("/signup");
  const form = page.locator('[data-testid="signup-form"]');
  await form.locator("#name").fill("Playwright Admin");
  await form.locator("#email").fill(email);
  await form.locator("#password").fill(PASSWORD);
  await form.locator('button[type="submit"]').click();
  await page.waitForURL("**/account", { timeout: 15_000 });
}

/**
 * Promotion happens in the database because there is no UI for it and there
 * should not be one: `profiles.role` is the only source of the admin bit
 * (lib/auth/viewer.ts), and nothing a client sends can influence it. Signing up
 * does not create the profile row — `ensureProfile` does, on first write — so
 * this inserts it.
 */
async function promoteToAdmin(email: string): Promise<void> {
  const sql = postgres(DATABASE_URL, { max: 1 });
  try {
    const rows = await sql<{ id: string }[]>`select id from "user" where email = ${email} limit 1`;
    const userId = rows[0]?.id;
    if (!userId) throw new Error(`No account was created for ${email}`);
    await sql`
      insert into profiles (user_id, role) values (${userId}, 'admin')
      on conflict (user_id) do update set role = 'admin'
    `;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * Files a pending listing straight into the database.
 *
 * The approval test goes through the real form because that path is the point
 * of the test. This one does not: /add-listing allows three submissions per IP
 * per hour, and a suite that spends two of them cannot run twice in an hour —
 * which is exactly what CI does (flags off, then flags on). The rejection path
 * starts at the queue, so the queue is where this test starts.
 */
async function seedPendingListing(name: string): Promise<string> {
  const sql = postgres(DATABASE_URL, { max: 1 });
  try {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const rows = await sql<{ id: string; city_id: string; vertical_id: string; category_id: string }[]>`
      select
        gen_random_uuid() as id,
        c.id as city_id,
        cat.vertical_id as vertical_id,
        cat.id as category_id
      from cities c
      cross join lateral (select id, vertical_id from categories where is_active limit 1) cat
      where c.slug = ${TOWN.slug}
      limit 1
    `;
    const seed = rows[0];
    if (!seed) throw new Error(`No town ${TOWN.slug} to file a submission against`);

    await sql`
      insert into listings (
        id, name, slug, city_id, vertical_id, primary_category_id,
        status, tier, claim_status, source,
        address_line1, postcode, phone, description, submitted_by_email, custom_fields
      ) values (
        ${seed.id}, ${name}, ${slug}, ${seed.city_id}, ${seed.vertical_id}, ${seed.category_id},
        'pending', 'free', 'unclaimed', 'public',
        '1 Test Lane', ${validPostcode()}, ${uniquePhone()},
        'Seeded by the admin end-to-end test to exercise the rejection path.',
        ${`${unique("submitter")}@example.com`},
        ${sql.json({ submission: { submitterName: "Playwright Submitter", requestedTier: "free" } })}
      )
    `;
    await sql`
      insert into slugs (parent_scope, slug, kind, entity_id)
      values (${seed.city_id}, ${slug}, 'listing', ${seed.id})
      on conflict do nothing
    `;
    return seed.id;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** Fills and sends the public submission form, the way a stranger would. */
async function submitListing(page: Page, name: string): Promise<void> {
  await page.goto("/add-listing");
  const form = page.locator('[data-testid="submit-listing-form"]');
  await expect(form).toBeVisible();

  await form.locator("#sl-name").fill(name);
  await form.locator("#sl-category").selectOption({ index: 1 });
  await form
    .locator("#sl-description")
    .fill(
      "Created by the admin end-to-end test to exercise the approval queue. " +
        "Long enough to clear the fifty-character minimum the form enforces.",
    );
  await form.locator("#sl-address").fill("1 Test Lane");
  await form.locator("#sl-region").selectOption(TOWN.region);
  await form.locator("#sl-city").fill(TOWN.city);
  await form.locator("#sl-postcode").fill(validPostcode());
  await form.locator("#sl-phone").fill(uniquePhone());
  await form.locator("#sl-your-name").fill("Playwright Submitter");
  await form.locator("#sl-your-email").fill(`${unique("submitter")}@example.com`);

  // The honeypot must stay empty — filling it returns a silent fake success.
  await expect(form.locator("#company_website")).toHaveValue("");
  await expect(form.locator('input[name="cf-turnstile-response"]')).not.toHaveValue("", {
    timeout: 15_000,
  });

  await form.locator('button[type="submit"]').click();
  await page.waitForURL("**/add-listing/thanks", { timeout: 20_000 });
}

test.describe("admin console", () => {
  test("an admin approves a submission and it appears on the town page", async ({ page }) => {
    const email = `${unique("admin")}@example.com`;
    const listingName = `E2E ${unique("Listing")}`;

    await signUp(page, email);
    await promoteToAdmin(email);
    await submitListing(page, listingName);

    // The dashboard counts it before anyone opens the queue.
    await page.goto("/admin");
    await expect(page.locator('[data-testid="admin-counts"]')).toBeVisible();
    await expect(page.locator('[data-testid="admin-nav"]')).toBeVisible();
    // Every queue the console counts is reachable from its nav — the claims
    // queue once shipped without an entry and nobody could open it.
    for (const href of ["/admin/claims", "/admin/reviews"]) {
      await expect(page.locator(`[data-testid="admin-nav"] a[href="${href}"]`)).toBeVisible();
    }

    await page.goto("/admin/submissions");
    const row = page.locator('[data-testid="submission-queue"] a', { hasText: listingName });
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.click();
    await page.waitForURL(/\/admin\/submissions\/[0-9a-f-]{36}$/);

    // Everything the submitter typed is on the decision page, including the
    // town as they typed it, which is not necessarily the one it resolved to.
    await expect(page.locator("h1")).toHaveText(listingName);
    await expect(page.locator("main")).toContainText("Playwright Submitter");
    await expect(page.locator("main")).toContainText("1 Test Lane");

    await page.locator('[data-testid="approve-submit"]').click();
    await page.waitForURL("**/admin/submissions", { timeout: 20_000 });
    await expect(page.locator('[data-testid="submission-queue"] a', { hasText: listingName }))
      .toHaveCount(0);

    // And it is on the open web. The town page is ISR-cached, so this reloads
    // until the revalidation the action triggered has landed rather than
    // asserting on whatever happened to be in the cache.
    await expect
      .poll(
        async () => {
          await page.goto(`/${TOWN.slug}`, { waitUntil: "domcontentloaded" });
          // Exact: the card's Save button repeats the name in a hidden suffix.
          return page.locator('[data-testid="listing-grid"]').getByText(listingName, { exact: true }).count();
        },
        { timeout: 60_000, message: "the approved listing must appear on its town page" },
      )
      .toBeGreaterThan(0);

    // The decision is on the record, with the actor resolved to a person.
    await page.goto("/admin/audit/listing");
    await expect(page.locator('[data-testid="audit-table"]')).toContainText("submission.approved");
    await expect(page.locator('[data-testid="audit-table"]')).toContainText(email);
  });

  test("a signed-in user who is not an admin cannot see the console", async ({ page }) => {
    await signUp(page, `${unique("plain")}@example.com`);

    const response = await page.goto("/admin");
    // 404, not 403: confirming /admin exists tells an attacker where to aim.
    expect(response?.status()).toBe(404);
    await expect(page.locator('[data-testid="admin-nav"]')).toHaveCount(0);
  });

  test("a rejection needs a reason before it will go through", async ({ page }) => {
    const email = `${unique("admin")}@example.com`;
    const listingName = `E2E ${unique("Listing")}`;

    await signUp(page, email);
    await promoteToAdmin(email);
    await seedPendingListing(listingName);

    await page.goto("/admin/submissions");
    await page.locator('[data-testid="submission-queue"] a', { hasText: listingName }).click();
    await page.waitForURL(/\/admin\/submissions\/[0-9a-f-]{36}$/);
    const detailUrl = page.url();

    // Whitespace is not a reason. The browser's own `required` blocks an empty
    // box, so this is the server's check being exercised.
    await page.locator("#reason").fill("   ");
    await page.locator('[data-testid="reject-submit"]').click();
    await expect(page.locator('[data-testid="reject-error"]')).toBeVisible({ timeout: 15_000 });
    expect(page.url()).toBe(detailUrl);

    await page.locator("#reason").fill("Created by an automated test — not a real business.");
    await page.locator('[data-testid="reject-submit"]').click();
    await page.waitForURL("**/admin/submissions", { timeout: 20_000 });

    await page.goto(detailUrl);
    await expect(page.locator("main")).toContainText("rejected");
    await expect(page.locator("main")).toContainText("not a real business");
  });
});
