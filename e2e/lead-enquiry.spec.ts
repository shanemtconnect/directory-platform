import { expect, test } from "@playwright/test";
import postgres from "postgres";
import { features } from "@/lib/features/flags";
import { leadPhone } from "./fixtures";
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
  await sql.end({ timeout: 5 });
});

test("an enquiry to an unclaimed no-email listing becomes a lead only after the enquirer confirms", async ({ page }) => {
  test.skip(!features.leadMarketplace, "leadMarketplace is off in this build");
  test.slow();

  const [target] = await sql<{ id: string; path: string }[]>`
    select l.id, '/' || c.slug || '/' || l.slug as path
    from listings l join cities c on c.id = l.city_id
    where l.status = 'published' and l.claim_status = 'unclaimed'
      and nullif(trim(l.email), '') is null and c.is_published
    order by l.created_at limit 1
  `;
  expect(target, "the e2e seed must have an unclaimed listing with no email").toBeTruthy();

  await page.goto(target!.path);
  const form = page.locator('[data-testid="enquiry-form"]');
  await expect(form).toBeVisible();
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
