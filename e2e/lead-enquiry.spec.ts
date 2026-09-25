import { expect, test } from "@playwright/test";
import postgres from "postgres";
import crypto from "node:crypto";
import { features } from "@/lib/features/flags";
import { leadPhone, sideCity } from "./fixtures";
import { leadSharingNotice } from "@/lib/leads/consent";
import { E2E_DATABASE_URL } from "./database";

/**
 * An enquiry to a listing nobody reads — published, unclaimed, no email —
 * with the lead marketplace on (Task 56, D5 + D6). The enquiry is written as
 * always; the enquirer is told to check their email; NO lead exists until
 * they open the link and press Confirm; then one open `enquiry` lead does.
 *
 * Flag off, the same enquiry creates no verification row and no lead, which
 * e2e/enquiry.spec.ts covers along with the unchanged privacy line.
 */

const stamp = Date.now();
const EMAIL = `enquiry-lead-e2e+${stamp}@example.com`;

let sql: ReturnType<typeof postgres>;
let fixtureId: string | null = null;

test.beforeAll(() => {
  sql = postgres(E2E_DATABASE_URL, { max: 2, onnotice: () => {} });
});

test.afterAll(async () => {
  if (!sql) return;
  const ids = await sql<{ id: string }[]>`select id from quote_requests where email = ${EMAIL}`;
  for (const { id } of ids) {
    await sql`delete from job_queue where payload->>'quoteRequestId' = ${id}`;
    await sql`delete from audit_log where entity_id = ${id}`;
  }
  const leadIds = await sql<{ id: string }[]>`select id from leads where email = ${EMAIL}`;
  for (const { id } of leadIds) await sql`delete from audit_log where entity_id = ${id}`;
  await sql`delete from leads where email = ${EMAIL}`;
  await sql`delete from quote_requests where email = ${EMAIL}`;
  await sql`delete from enquiries where email = ${EMAIL}`;
  if (fixtureId) {
    await sql`delete from slugs where entity_id = ${fixtureId}`;
    await sql`delete from listings where id = ${fixtureId}`;
    fixtureId = null;
  }
  await sql.end({ timeout: 5 });
});

test("an enquiry to an unclaimed no-email listing becomes a lead only after the enquirer confirms", async ({ page }) => {
  test.skip(!features.leadMarketplace, "leadMarketplace is off in this build");
  test.slow();

  // Our own listing, in a side town: the seed's oldest unclaimed listing is
  // what claim.spec claims, and once claimed its enquiry form promises an
  // owner again — which is exactly what this spec asserts it must not do.
  const city = await sideCity();
  const [scope] = await sql<{ city_id: string; vertical_id: string; category_id: string }[]>`
    select c.id as city_id, cat.vertical_id, cat.id as category_id
    from cities c, categories cat
    where c.slug = ${city.slug} and cat.is_active
    order by cat.sort_order, cat.name limit 1
  `;
  expect(scope, "the side town and an active category must exist").toBeTruthy();
  fixtureId = crypto.randomUUID();
  const slug = `e2e-enquiry-lead-${fixtureId.slice(0, 8)}`;
  await sql`insert into listings
    (id, name, slug, city_id, vertical_id, primary_category_id, status, tier, claim_status, email, source)
    values (${fixtureId}, ${"E2E Enquiry Lead Fixture"}, ${slug}, ${scope!.city_id}, ${scope!.vertical_id},
      ${scope!.category_id}, 'published', 'free', 'unclaimed', null, 'seed')`;
  await sql`insert into slugs (parent_scope, slug, kind, entity_id)
    values (${scope!.city_id}, ${slug}, 'listing', ${fixtureId}) on conflict do nothing`;
  const target = { id: fixtureId, path: `/${city.slug}/${slug}` };

  await page.goto(target!.path);
  const form = page.locator('[data-testid="enquiry-form"]');
  await expect(form).toBeVisible();
  // Nobody reads this listing's mail, so the form must not promise an owner.
  await expect(form).toContainText(leadSharingNotice());
  await expect(form).not.toContainText("goes straight to");
  await form.locator("#enq-name").fill("Playwright Enquirer");
  await form.locator("#enq-email").fill(EMAIL);
  await form.locator("#enq-phone").fill(leadPhone());
  await form.locator("#enq-message").fill(`Automated enquiry-lead test (${stamp}). Is 3 May free?`);
  await expect(form.locator('input[name="cf-turnstile-response"]')).not.toHaveValue("", { timeout: 15_000 });
  await form.locator('button[type="submit"]').click();

  const sent = page.locator('[data-testid="enquiry-sent"]');
  await expect(sent).toBeVisible({ timeout: 15_000 });
  await expect(sent.locator('[data-testid="enquiry-confirm-email"]')).toContainText("Check your email to confirm");

  const [request] = await sql<{ id: string; status: string; source: string; listing_id: string }[]>`
    select id, status, source, listing_id from quote_requests where email = ${EMAIL}
  `;
  expect(request).toMatchObject({ status: "pending", source: "enquiry", listing_id: target!.id });
  expect(await sql`select 1 from leads where email = ${EMAIL}`, "no unverified lead may exist").toHaveLength(0);
  const [job] = await sql<{ token: string }[]>`
    select payload->>'token' as token from job_queue
    where kind = 'notify.quote-verify' and payload->>'quoteRequestId' = ${request!.id}
  `;
  expect(job?.token).toBeTruthy();

  await page.goto(`/get-quotes/verify/${encodeURIComponent(job!.token)}`);
  const confirm = page.locator('[data-testid="quote-verify-confirm"]');
  await expect(confirm).toContainText("Confirm my enquiry");
  expect(await sql`select 1 from leads where email = ${EMAIL}`, "opening the link makes no lead").toHaveLength(0);
  await confirm.locator('button[type="submit"]').click();
  await page.waitForURL(/\/get-quotes\/confirmed\?state=verified$/);

  const [lead] = await sql<{ source: string; status: string; listing_id: string; quote_request_id: string }[]>`
    select source, status, listing_id, quote_request_id from leads where email = ${EMAIL}
  `;
  expect(lead).toMatchObject({ source: "enquiry", status: "open", listing_id: target!.id, quote_request_id: request!.id });
});
