import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import postgres from "postgres";
import { siteConfig } from "@/config/site.config";
import { features } from "@/lib/features/flags";
import { E2E_DATABASE_URL } from "./database";
import { leadPhone, sideCity } from "./fixtures";

/**
 * The lead market (Task 58), end to end: a verified lead on the board, an
 * owner with credit buys it, sees the details, reports it; an admin approves
 * the report, the credit comes back, and the lead's phone is refused on the
 * next quote request.
 *
 * The lead and the credit are written straight into the database: how a
 * lead is made (the requester's Confirm) is e2e/lead-quote.spec.ts, and how
 * credit is bought is e2e/credit.spec.ts. What is proved here is everything
 * after that, through the real pages. Flag-aware: with `leadMarketplace` off
 * the board is a 404 and nothing advertises it.
 */

const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const PASSWORD = `pw-${stamp}-longenough`;
const BUYER = `e2e-lead-buyer+${stamp}@example.com`;
const ADMIN = `e2e-lead-admin+${stamp}@example.com`;
const LEAD_EMAIL = `lead-market-e2e+${stamp}@example.com`;
const NEXT_EMAIL = `lead-market-e2e-again+${stamp}@example.com`;
const PHONE = leadPhone();
const PHONE_E164 = `+44${PHONE.replace(/\s+/g, "").slice(1)}`;
const FLOOR_CENTS = Math.round(siteConfig.leads.floor * 100);
const CREDIT = FLOOR_CENTS * 2;
const BRIEF = `E2E lead ${stamp}: sixty guests in August.`;

let sql: ReturnType<typeof postgres>;
const made: { leadId?: string; listingId?: string } = {};

test.beforeAll(() => {
  sql = postgres(E2E_DATABASE_URL, { max: 2, onnotice: () => {} });
});

test.afterAll(async () => {
  if (!sql) return;
  if (made.leadId) {
    const refunds = await sql<{ id: string }[]>`
      select r.id from lead_refunds r join lead_purchases p on p.id = r.purchase_id where p.lead_id = ${made.leadId}`;
    for (const { id } of refunds) await sql`delete from job_queue where payload->>'refundId' = ${id}`;
    const purchases = await sql<{ id: string }[]>`select id from lead_purchases where lead_id = ${made.leadId}`;
    for (const { id } of purchases) await sql`delete from job_queue where payload->>'purchaseId' = ${id}`;
  }
  // The accounts cascade to their profiles, and from there to the ledger,
  // the purchase and its refund.
  await sql`delete from "user" where email in (${BUYER}, ${ADMIN})`;
  if (made.leadId) {
    await sql`delete from lead_blocklist where lead_id = ${made.leadId}`;
    await sql`delete from audit_log where entity_id = ${made.leadId}`;
    await sql`delete from leads where id = ${made.leadId}`;
  }
  if (made.listingId) {
    await sql`delete from slugs where kind = 'listing' and entity_id = ${made.listingId}`;
    await sql`delete from listings where id = ${made.listingId}`;
  }
  await sql`delete from lead_blocklist where value in (${PHONE_E164}, ${LEAD_EMAIL})`;
  await sql`delete from quote_requests where email = ${NEXT_EMAIL}`;
  await sql.end({ timeout: 5 });
});

async function signUp(page: Page, email: string, name: string): Promise<string> {
  await page.goto("/signup");
  const form = page.locator('[data-testid="signup-form"]');
  await form.locator("#name").fill(name);
  await form.locator("#email").fill(email);
  await form.locator("#password").fill(PASSWORD);
  await form.locator('button[type="submit"]').click();
  await page.waitForURL(/\/account$/, { timeout: 30_000 });
  const [u] = await sql<{ id: string }[]>`select id from "user" where email = ${email}`;
  const [p] = await sql<{ id: string }[]>`
    insert into profiles (user_id) values (${u!.id})
    on conflict (user_id) do update set user_id = excluded.user_id returning id`;
  return p!.id;
}

test("buy a lead off the board, report it, the admin refunds it, and its phone is refused next time", async ({ page, browser }) => {
  test.slow();
  if (!features.leadMarketplace) {
    const res = await page.goto("/leads");
    expect(res?.status()).toBe(404);
    await page.goto("/");
    await expect(page.locator('header a[href="/leads"]')).toHaveCount(0);
    return;
  }

  // A signed-out visitor is sent to sign in.
  await page.goto("/leads");
  await page.waitForURL(/\/login\?next=%2Fleads|\/login\?next=\/leads/);

  // The buyer: an account, a live listing of theirs in a side town, and credit for two leads.
  const buyerProfile = await signUp(page, BUYER, "Playwright Buyer");
  const city = await sideCity();
  const [scope] = await sql<{ city_id: string; vertical_id: string; category_id: string }[]>`
    select c.id as city_id, cat.vertical_id, cat.id as category_id
    from cities c, categories cat where c.slug = ${city.slug} and cat.is_active order by cat.sort_order, cat.slug limit 1`;
  made.listingId = randomUUID();
  const slug = `e2e-lead-buyer-${made.listingId.slice(0, 8)}`;
  await sql`insert into listings (id, name, slug, city_id, vertical_id, primary_category_id, status, tier, claim_status, owner_id, source)
    values (${made.listingId}, ${`E2E Lead Buyer ${stamp}`}, ${slug}, ${scope!.city_id}, ${scope!.vertical_id}, ${scope!.category_id},
      'published', 'free', 'claimed', ${buyerProfile}, 'seed')`;
  await sql`insert into slugs (parent_scope, slug, kind, entity_id) values (${scope!.city_id}, ${slug}, 'listing', ${made.listingId}) on conflict do nothing`;
  await sql`insert into credit_ledger (user_id, delta_cents, kind, note) values (${buyerProfile}, ${CREDIT}, 'topup', 'e2e fixture')`;

  // A verified lead, as the requester's Confirm leaves it.
  made.leadId = randomUUID();
  await sql`insert into leads (id, source, city_id, category_id, first_name, brief, name, email, phone, phone_normalised,
      email_normalised, message, status, price_cents, half_price_at, expires_at)
    values (${made.leadId}, 'capture', ${scope!.city_id}, ${scope!.category_id}, 'Playwright', ${BRIEF}, 'Playwright Requester',
      ${LEAD_EMAIL}, ${PHONE}, ${PHONE_E164}, ${LEAD_EMAIL}, ${`${BRIEF} Call ${PHONE}.`}, 'open', ${FLOOR_CENTS},
      now() + interval '7 days', now() + interval '30 days')`;

  // The board: the header links it, the row shows the brief and never the contact.
  await page.goto("/leads");
  await expect(page.locator('header a[href="/leads"]').first()).toBeVisible();
  await expect(page.locator('[data-testid="lead-refund-policy"]')).toContainText(`${siteConfig.leads.refundWindowDays} days`);
  const row = page.locator(`[data-testid="lead-row"][data-lead-id="${made.leadId}"]`);
  await expect(row).toContainText(BRIEF);
  await expect(row).toContainText(city.name);
  const board = await page.locator('[data-testid="lead-board"]').innerText();
  expect(board).not.toContain(LEAD_EMAIL);
  expect(board).not.toContain(PHONE);

  // Buy it: the details are revealed on its page.
  await row.locator('[data-testid="lead-buy"]').click();
  await page.waitForURL(new RegExp(`/leads/${made.leadId}$`));
  await expect(page.locator('[data-testid="lead-phone"]')).toContainText(PHONE);
  await expect(page.locator('[data-testid="lead-email"]')).toContainText(LEAD_EMAIL);
  const [bought] = await sql<{ n: number }[]>`select coalesce(sum(delta_cents), 0)::int as n from credit_ledger where user_id = ${buyerProfile}`;
  expect(bought!.n).toBe(CREDIT - FLOOR_CENTS);

  // Report it.
  const report = page.locator('[data-testid="lead-report-form"]');
  await report.locator('input[name="reason"][value="dead_phone"]').check();
  await report.locator("#lead-report-note").fill("Number unobtainable, tried twice.");
  await report.locator('[data-testid="lead-report-submit"]').click();
  await page.waitForURL(/\?report=requested$/);
  await expect(page.locator('[data-testid="lead-refund-status"]')).toHaveAttribute("data-status", "pending");

  // The admin approves it.
  const adminContext = await browser.newContext();
  const admin = await adminContext.newPage();
  await signUp(admin, ADMIN, "Playwright Lead Admin");
  await sql`update profiles set role = 'admin' where user_id = (select id from "user" where email = ${ADMIN})`;
  await admin.goto("/admin/leads");
  await expect(admin.locator('[data-testid="admin-nav"] a[href="/admin/leads"]')).toBeVisible();
  const refundRow = admin.locator(`[data-testid="refund-row"][data-lead-id="${made.leadId}"]`);
  await expect(refundRow).toContainText("Number unobtainable");
  await refundRow.locator('[data-testid="refund-approve"]').click();
  await admin.waitForURL(/\/admin\/leads\?refund=approved$/);
  await adminContext.close();

  // The buyer's credit is back, and the lead still belongs to them, marked refunded.
  await page.goto("/account/credit");
  await expect(page.locator('[data-testid="credit-balance"]')).toHaveAttribute("data-cents", String(CREDIT));
  await page.goto(`/leads/${made.leadId}`);
  await expect(page.locator('[data-testid="lead-refund-status"]')).toHaveAttribute("data-status", "approved");
  const [lead] = await sql<{ status: string }[]>`select status from leads where id = ${made.leadId}`;
  expect(lead!.status).toBe("sold");

  // The phone is now blocklisted: a quote request from it, with nobody local to receive it, is refused.
  const [quoteScope] = await sql<{ city_id: string; category_id: string }[]>`
    select c.id as city_id, cat.id as category_id
    from listings l
    join cities c on c.id = l.city_id
    join categories cat on cat.id = l.primary_category_id
    where l.status = 'published' and c.is_published and c.is_indexable and cat.is_active
    group by c.id, cat.id
    having count(*) = 1 and bool_and(nullif(trim(l.email), '') is null and l.owner_id is null)
    order by c.name desc, cat.name desc
    limit 1
  `;
  expect(quoteScope, "the e2e seed must have a town and category with one unaddressed listing").toBeTruthy();
  await page.goto("/get-quotes");
  const form = page.locator('[data-testid="quote-form"]');
  await form.locator("#quote-category").selectOption(quoteScope!.category_id);
  await form.locator("#quote-town").selectOption(quoteScope!.city_id);
  await form.locator("#quote-message").fill(`Another request (${stamp}) from the same phone.`);
  await form.locator("#quote-name").fill("Playwright Requester");
  await form.locator("#quote-email").fill(NEXT_EMAIL);
  await form.locator("#quote-phone").fill(PHONE);
  await form.locator("#quote-consent").check();
  await expect(form.locator('input[name="cf-turnstile-response"]')).not.toHaveValue("", { timeout: 15_000 });
  await form.locator('button[type="submit"]').click();
  await expect(page.locator('[data-testid="quote-error"]')).toContainText("can't accept a request from these contact details", { timeout: 15_000 });
  expect(await sql`select 1 from quote_requests where email = ${NEXT_EMAIL}`).toHaveLength(0);
});
