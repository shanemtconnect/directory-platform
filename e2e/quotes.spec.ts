import { expect, test } from "@playwright/test";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { features } from "@/lib/features/flags";
import { uniquePhone } from "./fixtures";
import { E2E_DATABASE_URL } from "./database";

/**
 * The quote broadcast, end to end against a production build.
 *
 * A visitor describes a job on /get-quotes; the request is written with its
 * recipients and one `notify.quote` job; the worker (run here in-process,
 * against the same database — Playwright starts no worker) drains that job;
 * and the owner of a paid recipient sees the job and the requester on the
 * leads page, while the same listing on the free tier sees only that a
 * request arrived.
 *
 * The seed gives no listing an address, so two listings in the busiest
 * town+category are lent one for the run and restored afterwards; one of
 * them is handed to the account this spec signs up. Everything written is
 * undone in `afterAll`.
 *
 * Only meaningful with the flag on: under the flags-off build the page is a
 * 404 by design, which e2e/routes.spec.ts already covers.
 */
test.skip(!features.quoteBroadcast, "quoteBroadcast is off in this build");

const stamp = Date.now();
const ACCOUNT_EMAIL = `quote-e2e-owner+${stamp}@example.com`;
const REQUESTER_EMAIL = `quote-e2e-requester+${stamp}@example.com`;
const PASSWORD = "not-a-real-password-e2e";
const JOB = `Automated end-to-end quote request (${stamp}): about eighty people in June, with parking.`;

interface Lent {
  id: string;
  email: string | null;
  ownerId: string | null;
  tier: string;
  claimStatus: string;
}

let sql: ReturnType<typeof postgres>;
let cityId: string;
let categoryId: string;
let owned: Lent;
let other: Lent;
let quoteRequestId: string | null = null;

test.beforeAll(async () => {
  sql = postgres(E2E_DATABASE_URL, { max: 2, onnotice: () => {} });

  const [scope] = await sql<{ city_id: string; category_id: string }[]>`
    select c.id as city_id, cat.id as category_id
    from listings l
    join cities c on c.id = l.city_id
    join categories cat on cat.id = l.primary_category_id
    where l.status = 'published' and c.is_published and c.is_indexable and cat.is_active
    group by c.id, cat.id
    having count(*) >= 2
    order by count(*) desc, c.name, cat.name
    limit 1
  `;
  if (!scope) throw new Error("The e2e database has no indexable town with two published listings in one category");
  cityId = scope.city_id;
  categoryId = scope.category_id;

  const rows = await sql<{ id: string; email: string | null; owner_id: string | null; tier: string; claim_status: string }[]>`
    select id, email, owner_id, tier, claim_status from listings
    where city_id = ${cityId} and primary_category_id = ${categoryId}
      and status = 'published' and owner_id is null
    order by created_at limit 2
  `;
  if (rows.length < 2) throw new Error("Need two unowned published listings in the chosen town and category");
  const lend = (r: (typeof rows)[number]): Lent => ({
    id: r.id, email: r.email, ownerId: r.owner_id, tier: r.tier, claimStatus: r.claim_status,
  });
  owned = lend(rows[0]!);
  other = lend(rows[1]!);

  await sql`update listings set email = ${`quote-e2e-a+${stamp}@example.com`} where id = ${owned.id}`;
  await sql`update listings set email = ${`quote-e2e-b+${stamp}@example.com`} where id = ${other.id}`;
});

test.afterAll(async () => {
  if (!sql) return;
  for (const l of [owned, other]) {
    if (!l) continue;
    await sql`
      update listings
      set email = ${l.email}, owner_id = ${l.ownerId}, tier = ${l.tier}::listing_tier,
          claim_status = ${l.claimStatus}::claim_status
      where id = ${l.id}
    `;
  }
  if (quoteRequestId !== null) {
    await sql`delete from job_queue where payload->>'quoteRequestId' = ${quoteRequestId}`;
    await sql`delete from audit_log where entity_id = ${quoteRequestId}`;
  }
  // Cascades to quote_recipients.
  await sql`delete from quote_requests where email = ${REQUESTER_EMAIL}`;
  // Deleting the user cascades to its profile and session rows.
  await sql`delete from "user" where email = ${ACCOUNT_EMAIL}`;
  await sql.end({ timeout: 5 });
});

test.describe("the quote broadcast", () => {
  test("request, worker delivery, and the owner's leads page under both tiers", async ({ page }) => {
    test.slow();

    // An account that owns one of the two recipients, on a paid tier.
    await page.goto("/signup");
    const signup = page.locator('[data-testid="signup-form"]');
    await expect(signup).toBeVisible();
    await signup.locator("#name").fill("Quote E2E");
    await signup.locator("#email").fill(ACCOUNT_EMAIL);
    await signup.locator("#password").fill(PASSWORD);
    await signup.locator('button[type="submit"]').click();
    await page.waitForURL(/\/account$/, { timeout: 30_000 });

    // Ownership is the claim flow's business (e2e/claim.spec.ts proves it);
    // here it is a precondition, set the way an approved claim sets it.
    const [account] = await sql<{ id: string }[]>`select id from "user" where email = ${ACCOUNT_EMAIL}`;
    expect(account?.id, "the sign-up must have created the account").toBeTruthy();
    await sql`insert into profiles (user_id) values (${account!.id}) on conflict (user_id) do nothing`;
    await sql`
      update listings
      set owner_id = (select id from profiles where user_id = ${account!.id}),
          tier = 'essential', claim_status = 'claimed'
      where id = ${owned.id}
    `;

    // The request.
    await page.goto("/get-quotes");
    const form = page.locator('[data-testid="quote-form"]');
    await expect(form).toBeVisible();
    await form.locator("#quote-category").selectOption(categoryId);
    await form.locator("#quote-town").selectOption(cityId);
    await form.locator("#quote-message").fill(JOB);
    await form.locator("#quote-name").fill("Playwright Requester");
    await form.locator("#quote-email").fill(REQUESTER_EMAIL);
    await form.locator("#quote-phone").fill(uniquePhone());
    await form.locator("#quote-consent").check();
    await expect(form.locator("#company_website")).toHaveValue("");
    await expect(form.locator('input[name="cf-turnstile-response"]'))
      .not.toHaveValue("", { timeout: 15_000 });
    await form.locator('button[type="submit"]').click();

    const sent = page.locator('[data-testid="quote-sent"]');
    await expect(sent, "confirmation must replace the form").toBeVisible({ timeout: 15_000 });
    await expect(sent).toContainText(/Sent to \d+ /);
    await expect(form).toHaveCount(0);

    // Written with both lent listings as recipients, and one queued job.
    const [request] = await sql<{ id: string }[]>`
      select id from quote_requests where email = ${REQUESTER_EMAIL} order by created_at desc limit 1
    `;
    expect(request?.id, "the request must be stored").toBeTruthy();
    quoteRequestId = request!.id;
    const recipients = await sql<{ listing_id: string }[]>`
      select listing_id from quote_recipients where quote_request_id = ${quoteRequestId}
    `;
    expect(recipients.map((r) => r.listing_id)).toEqual(expect.arrayContaining([owned.id, other.id]));
    const [job] = await sql<{ id: string; status: string }[]>`
      select id, status from job_queue
      where kind = 'notify.quote' and payload->>'quoteRequestId' = ${quoteRequestId}
    `;
    expect(job?.status, "one notify.quote job must be queued").toBe("pending");

    // The worker, in-process against the same database. No mail provider is
    // configured here, so each delivery resolves `not-configured` and the
    // job completes — what is proved is that the handler reads the request,
    // resolves its recipients and finishes, not that Resend was called.
    // Other specs leave jobs behind in this database and the claim takes the
    // longest-waiting first, so ours is pushed to the front of the queue —
    // what is under test is this job's handler, not the tick's ordering.
    await sql`update job_queue set run_after = to_timestamp(0) where id = ${job!.id}`;
    process.env.DATABASE_URL = E2E_DATABASE_URL;
    process.env.NEXT_PUBLIC_SITE_URL ??= "http://localhost:3200";
    delete process.env.RESEND_API_KEY;
    const schema = await import("@/lib/db/schema");
    const { processNotifications } = await import("@/worker/jobs/notify");
    const workerSql = postgres(E2E_DATABASE_URL, { max: 1, onnotice: () => {} });
    try {
      const db = drizzle(workerSql, { schema });
      const completed = await db.transaction(async (tx) =>
        processNotifications(tx as unknown as Parameters<typeof processNotifications>[0]),
      );
      expect(completed, "the tick must complete at least this job").toBeGreaterThanOrEqual(1);
    } finally {
      await workerSql.end({ timeout: 5 });
    }
    const [done] = await sql<{ status: string; attempts: number; last_error: string | null }[]>`
      select status, attempts, last_error from job_queue where id = ${job!.id}
    `;
    expect(done?.status, `the worker must complete the job (attempts ${done?.attempts}: ${done?.last_error ?? ""})`).toBe("done");

    // The paid owner sees the job and the requester.
    await page.goto(`/account/listings/${owned.id}`);
    await page.locator('[data-testid="leads-link"]').click();
    await page.waitForURL(new RegExp(`/account/listings/${owned.id}/leads$`));
    const inbox = page.locator('[data-testid="leads-inbox"]');
    await expect(inbox).toBeVisible();
    await expect(inbox.locator('[data-testid="lead-job"]').first()).toContainText(String(stamp));
    await expect(inbox).toContainText(REQUESTER_EMAIL);
    await expect(page.locator('[data-testid="leads-upsell"]')).toHaveCount(0);

    // The same listing on the free tier is told a request arrived, and no more.
    await sql`update listings set tier = 'free' where id = ${owned.id}`;
    await page.reload();
    await expect(page.locator('[data-testid="leads-upsell"]')).toBeVisible();
    await expect(page.locator('[data-testid="lead-masked"]').first()).toBeVisible();
    await expect(page.locator('[data-testid="lead-job"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="leads-inbox"]')).not.toContainText(REQUESTER_EMAIL);
  });
});
