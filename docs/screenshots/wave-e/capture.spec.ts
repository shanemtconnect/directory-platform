import { test, type Page } from "@playwright/test";
import postgres from "postgres";
import { E2E_DATABASE_URL } from "../../../e2e/database";

/**
 * Captures the wave-E screens, before and after the polish, at two widths.
 *
 * It signs up a throwaway account, promotes it to admin in the database (the
 * same way e2e/admin.spec.ts does — there is no UI for it and there must not
 * be one), lends it one seeded listing to own for the account screens, files
 * one pending submission for the queue, and puts everything back afterwards.
 */

const PHASE = process.env.SHOT_PHASE ?? "after";
const OUT = new URL(".", import.meta.url).pathname;
const PASSWORD = "not-a-real-password";
const stamp = Date.now();
const EMAIL = `wave-e-shots+${stamp}@example.com`;

let sql: ReturnType<typeof postgres>;
let ownedListingId: string;
let ownedListingPrev: { owner_id: string | null; claim_status: string };
let claimListingId: string;
let claimListingWebsite: string | null;
let pendingListingId: string;

function shot(page: Page, name: string, project: string): Promise<Buffer> {
  return page.screenshot({
    path: `${OUT}${name}-${project}-${PHASE}.png`,
    fullPage: true,
    animations: "disabled",
  });
}

async function signUp(page: Page): Promise<void> {
  await page.goto("/signup");
  const form = page.locator('[data-testid="signup-form"]');
  await form.locator("#name").fill("Wave E Screens");
  await form.locator("#email").fill(EMAIL);
  await form.locator("#password").fill(PASSWORD);
  await form.locator('button[type="submit"]').click();
  await page.waitForURL("**/account", { timeout: 15_000 });
}

async function signIn(page: Page): Promise<void> {
  await page.goto("/login");
  const form = page.locator('[data-testid="login-form"]');
  await form.locator("#email").fill(EMAIL);
  await form.locator("#password").fill(PASSWORD);
  await form.locator('button[type="submit"]').click();
  await page.waitForURL("**/account", { timeout: 15_000 });
}

test.beforeAll(async () => {
  sql = postgres(E2E_DATABASE_URL, { max: 1, onnotice: () => {} });
  const [owned, forClaim] = await sql<{ id: string; owner_id: string | null; claim_status: string; website: string | null }[]>`
    select id, owner_id, claim_status, website from listings
    where status = 'published' and claim_status = 'unclaimed' and owner_id is null
    order by created_at limit 2
  `;
  if (!owned || !forClaim) throw new Error("Need two unclaimed published listings to shoot");
  ownedListingId = owned.id;
  ownedListingPrev = { owner_id: owned.owner_id, claim_status: owned.claim_status };
  claimListingId = forClaim.id;
  claimListingWebsite = forClaim.website;
  await sql`update listings set website = 'https://www.wave-e-shots.example' where id = ${claimListingId}`;

  const slug = `wave-e-pending-${stamp}`;
  const [seed] = await sql<{ id: string; city_id: string; vertical_id: string; category_id: string }[]>`
    select gen_random_uuid() as id, c.id as city_id, cat.vertical_id, cat.id as category_id
    from cities c cross join lateral (select id, vertical_id from categories where is_active limit 1) cat
    where c.slug = 'richmond' limit 1
  `;
  if (!seed) throw new Error("No richmond to file a submission against");
  pendingListingId = seed.id;
  await sql`
    insert into listings (id, name, slug, city_id, vertical_id, primary_category_id, status, tier, claim_status, source,
      address_line1, postcode, phone, description, submitted_by_email, custom_fields)
    values (${seed.id}, ${"Wave E Pending Example"}, ${slug}, ${seed.city_id}, ${seed.vertical_id}, ${seed.category_id},
      'pending', 'free', 'unclaimed', 'public', '1 Test Lane', 'TW9 1AA', '020 7946 0999',
      'Seeded by the wave-E screenshot run so the submissions queue has a row in it.',
      ${`wave-e-submitter+${stamp}@example.com`},
      ${sql.json({ submission: { submitterName: "Screenshot Submitter", requestedTier: "free" } })})
  `;
  await sql`insert into slugs (parent_scope, slug, kind, entity_id) values (${seed.city_id}, ${slug}, 'listing', ${seed.id}) on conflict do nothing`;
});

test.afterAll(async () => {
  if (!sql) return;
  try {
    if (pendingListingId) {
      await sql`delete from slugs where entity_id = ${pendingListingId}`;
      await sql`delete from listings where id = ${pendingListingId}`;
    }
    if (ownedListingId) {
      await sql`update listings set owner_id = ${ownedListingPrev.owner_id}, claim_status = ${ownedListingPrev.claim_status}::claim_status where id = ${ownedListingId}`;
    }
    if (claimListingId) {
      await sql`update listings set website = ${claimListingWebsite} where id = ${claimListingId}`;
    }
    await sql`delete from "user" where email = ${EMAIL}`;
  } finally {
    await sql.end({ timeout: 5 });
  }
});

test("captures every screen", async ({ page }, info) => {
  const project = info.project.name;
  test.setTimeout(240_000);

  // A fresh account per project, because the sign-up on the second run
  // would collide with the first. Same address, so the cleanup finds it.
  const exists = await sql<{ id: string }[]>`select id from "user" where email = ${EMAIL} limit 1`;
  if (exists.length === 0) await signUp(page);
  else await signIn(page);

  const [profile] = await sql<{ id: string }[]>`
    insert into profiles (user_id, role)
    select id, 'admin' from "user" where email = ${EMAIL}
    on conflict (user_id) do update set role = 'admin' returning id
  `;
  if (!profile) throw new Error("No profile row for the screenshot account");
  await sql`update listings set owner_id = ${profile.id}, claim_status = 'claimed' where id = ${ownedListingId}`;

  await page.goto("/forgot-password");
  await shot(page, "forgot-password", project);

  await page.goto("/account");
  await shot(page, "account", project);

  await page.goto(`/account/listings/${ownedListingId}`);
  await shot(page, "account-listing", project);

  await page.goto("/account/billing");
  await shot(page, "account-billing", project);

  await page.goto("/account/settings");
  await shot(page, "account-settings", project);

  await page.goto(`/claim/${claimListingId}`);
  await shot(page, "claim", project);

  await page.goto(`/leave-review/${ownedListingId}`);
  await shot(page, "leave-review", project);

  await page.goto("/admin");
  await shot(page, "admin", project);

  await page.goto("/admin/submissions");
  await shot(page, "admin-submissions", project);

  await page.goto(`/admin/submissions/${pendingListingId}`);
  await shot(page, "admin-submission-detail", project);

  await page.goto("/admin/reports");
  await shot(page, "admin-reports", project);
});
