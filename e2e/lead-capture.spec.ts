import { expect, test } from "@playwright/test";
import postgres from "postgres";
import { features } from "@/lib/features/flags";
import { uniquePhone } from "./fixtures";
import { E2E_DATABASE_URL } from "./database";

/**
 * The lead-capture box (flag `leadMarketplace`, Task 56), end to end against
 * a production build.
 *
 * Flag on: the home page carries the box; a visitor fills it in, is told to
 * check their email, and the only thing written is a PENDING capture request
 * with one `notify.quote-verify` job. Following the link makes an OPEN lead
 * at the floor price and emails nobody else.
 *
 * Flag off (the flags-off build): the home page has no box at all.
 */

const stamp = Date.now();
const EMAIL = `capture-e2e+${stamp}@example.com`;
const JOB = `Automated capture box request (${stamp}): ten desks to move next month.`;

let sql: ReturnType<typeof postgres>;

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
  await sql.end({ timeout: 5 });
});

test("the home page has no capture box with the lead marketplace off", async ({ page }) => {
  test.skip(features.leadMarketplace, "leadMarketplace is on in this build");
  await page.goto("/");
  await expect(page.locator("h1")).toBeVisible();
  await expect(page.locator('[data-testid="lead-capture"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="lead-capture-form"]')).toHaveCount(0);
});

test("capture box on the home page: request, verification link, open lead", async ({ page }) => {
  test.skip(!features.leadMarketplace, "leadMarketplace is off in this build");
  test.slow();

  await page.goto("/");
  const box = page.locator('[data-testid="lead-capture"][data-variant="home"]');
  await expect(box).toBeVisible();
  const form = box.locator('[data-testid="lead-capture-form"]');
  await form.locator("#lead-capture-home-category").selectOption({ index: 1 });
  await form.locator("#lead-capture-home-town").selectOption({ index: 1 });
  await form.locator("#lead-capture-home-message").fill(JOB);
  await form.locator("#lead-capture-home-name").fill("Playwright Capture");
  await form.locator("#lead-capture-home-email").fill(EMAIL);
  await form.locator("#lead-capture-home-phone").fill(uniquePhone());
  await form.locator("#lead-capture-home-consent").check();
  await expect(form.locator('input[name="cf-turnstile-response"]')).not.toHaveValue("", { timeout: 15_000 });
  await form.locator('button[type="submit"]').click();

  await expect(box.locator('[data-testid="lead-capture-sent"]')).toBeVisible({ timeout: 15_000 });

  const [request] = await sql<{ id: string; status: string; source: string }[]>`
    select id, status, source from quote_requests where email = ${EMAIL}
  `;
  expect(request).toMatchObject({ status: "pending", source: "capture" });
  const recipients = await sql`select 1 from quote_recipients where quote_request_id = ${request!.id}`;
  expect(recipients, "a capture request is never broadcast").toHaveLength(0);
  expect(await sql`select 1 from leads where email = ${EMAIL}`, "no lead before the click").toHaveLength(0);
  const [job] = await sql<{ token: string }[]>`
    select payload->>'token' as token from job_queue
    where kind = 'notify.quote-verify' and payload->>'quoteRequestId' = ${request!.id}
  `;
  expect(job?.token).toBeTruthy();

  await page.goto(`/get-quotes/verify?token=${encodeURIComponent(job!.token)}`);
  await page.waitForURL(/\/get-quotes\/confirmed\?state=verified$/);
  await expect(page.locator('[data-testid="quote-confirmed"]')).toBeVisible();

  const [lead] = await sql<{ source: string; status: string; price_cents: number; brief: string; quote_request_id: string }[]>`
    select source, status, price_cents, brief, quote_request_id from leads where email = ${EMAIL}
  `;
  expect(lead).toMatchObject({ source: "capture", status: "open", quote_request_id: request!.id });
  expect(lead!.price_cents).toBeGreaterThanOrEqual(100);
  expect(lead!.brief).not.toContain("@");
  const deliveries = await sql`
    select 1 from job_queue where kind = 'notify.quote' and payload->>'quoteRequestId' = ${request!.id}
  `;
  expect(deliveries, "a capture lead emails no business").toHaveLength(0);
});
