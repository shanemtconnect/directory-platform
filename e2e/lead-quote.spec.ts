import { expect, test } from "@playwright/test";
import postgres from "postgres";
import { features } from "@/lib/features/flags";
import { leadPhone } from "./fixtures";
import { E2E_DATABASE_URL } from "./database";

/**
 * A get-quotes request nobody in town can receive, with the lead marketplace
 * on (Task 56). Its only destination is a lead, so it is held to the lead
 * rules AT SUBMIT: without a phone it is refused on the phone field and
 * nothing is written — never "on its way" and then silently dropped. With a
 * phone it is written pending, and confirming it makes an open `quote` lead.
 *
 * (Flag off, the same request gets the old "Nobody in that town… Try a
 * nearby town" refusal — unit-tested in lib/actions/quotes.test.ts.)
 */

const stamp = Date.now();
const EMAIL = `quote-lead-e2e+${stamp}@example.com`;
const JOB = `Automated zero-recipient quote (${stamp}): sixty guests in August.`;

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

test("a request nobody local can receive needs a phone, then becomes a lead on confirmation", async ({ page }) => {
  test.skip(!features.leadMarketplace, "leadMarketplace is off in this build");
  test.slow();

  // A town and category where no published listing has an address or an
  // owner — the seed gives none an email — and that e2e/quotes.spec.ts,
  // which lends two listings an address in the BUSIEST pair, never picks.
  const [scope] = await sql<{ city_id: string; category_id: string }[]>`
    select c.id as city_id, cat.id as category_id
    from listings l
    join cities c on c.id = l.city_id
    join categories cat on cat.id = l.primary_category_id
    where l.status = 'published' and c.is_published and c.is_indexable and cat.is_active
    group by c.id, cat.id
    having count(*) = 1 and bool_and(nullif(trim(l.email), '') is null and l.owner_id is null)
    order by c.name, cat.name
    limit 1
  `;
  expect(scope, "the e2e seed must have a town and category with one unaddressed listing").toBeTruthy();

  await page.goto("/get-quotes");
  const form = page.locator('[data-testid="quote-form"]');
  await form.locator("#quote-category").selectOption(scope!.category_id);
  await form.locator("#quote-town").selectOption(scope!.city_id);
  await form.locator("#quote-message").fill(JOB);
  await form.locator("#quote-name").fill("Playwright Leadless");
  await form.locator("#quote-email").fill(EMAIL);
  await form.locator("#quote-consent").check();
  await expect(form.locator('input[name="cf-turnstile-response"]')).not.toHaveValue("", { timeout: 15_000 });
  await form.locator('button[type="submit"]').click();

  // Refused on the phone, and nothing written.
  await expect(page.locator('[data-testid="quote-error"]')).toBeVisible({ timeout: 15_000 });
  await expect(form).toContainText("phone number we can call");
  expect(await sql`select 1 from quote_requests where email = ${EMAIL}`).toHaveLength(0);

  // With a phone: held for confirmation, no recipients.
  await form.locator("#quote-phone").fill(leadPhone());
  await expect(form.locator('input[name="cf-turnstile-response"]')).not.toHaveValue("", { timeout: 15_000 });
  await form.locator('button[type="submit"]').click();
  await expect(page.locator('[data-testid="quote-sent"]')).toContainText("pass it on", { timeout: 15_000 });

  const [request] = await sql<{ id: string; status: string }[]>`
    select id, status from quote_requests where email = ${EMAIL}
  `;
  expect(request?.status).toBe("pending");
  expect(await sql`select 1 from quote_recipients where quote_request_id = ${request!.id}`).toHaveLength(0);
  const [job] = await sql<{ token: string }[]>`
    select payload->>'token' as token from job_queue
    where kind = 'notify.quote-verify' and payload->>'quoteRequestId' = ${request!.id}
  `;

  await page.goto(`/get-quotes/verify/${encodeURIComponent(job!.token)}`);
  await page.locator('[data-testid="quote-verify-confirm"] button[type="submit"]').click();
  await page.waitForURL(/\/get-quotes\/confirmed\?state=verified$/);

  const [lead] = await sql<{ source: string; status: string }[]>`select source, status from leads where email = ${EMAIL}`;
  expect(lead).toEqual({ source: "quote", status: "open" });
});
