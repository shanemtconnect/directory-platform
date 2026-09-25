import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { features } from "@/lib/features/flags";
import { E2E_DATABASE_URL } from "./database";

/**
 * Saved searches and their email alerts (Task 54), end to end against a
 * production build.
 *
 * A new account saves a search on /search; /account/alerts lists it; a
 * listing matching it is published; the hourly dispatch and the notify
 * drain (run here in-process, against the same database — Playwright starts
 * no worker) queue and complete one digest and move the search's watermark;
 * and the digest's unsubscribe link, followed and confirmed, switches the
 * search off. No mail provider is configured, so the send resolves
 * `not-configured` and the job completes: what is proved is that the digest
 * is built for the right search and the bookkeeping moves, not that Resend
 * was called (worker/jobs/notify-alerts.test.ts checks the email itself).
 *
 * Everything written is undone in `afterAll`.
 */

const stamp = Date.now();
const EMAIL = `alerts-e2e+${stamp}@example.com`;
const PASSWORD = "not-a-real-password-e2e";
// A word no seeded listing contains, so the saved search matches only the fixture.
const TAG = `alertse2e${stamp}`;

let sql: ReturnType<typeof postgres>;
let listingId: string | null = null;
let savedSearchId: string | null = null;

async function signUp(page: Page): Promise<void> {
  await page.goto("/signup");
  const form = page.locator('[data-testid="signup-form"]');
  await expect(form).toBeVisible();
  await form.locator("#name").fill("Alerts E2E");
  await form.locator("#email").fill(EMAIL);
  await form.locator("#password").fill(PASSWORD);
  await form.locator('button[type="submit"]').click();
  await page.waitForURL(/\/account$/, { timeout: 30_000 });
}

/** The worker's code, in this process, against the e2e database — env restored afterwards. */
async function asWorker<T>(fn: (tx: never) => Promise<T>): Promise<T> {
  const env = { ...process.env };
  process.env.DATABASE_URL = E2E_DATABASE_URL;
  process.env.BETTER_AUTH_SECRET ??= "e2e-not-a-real-secret";
  // The drain also meets this spec's sign-up verification mail, which needs an origin.
  process.env.NEXT_PUBLIC_SITE_URL ??= `http://localhost:${process.env.E2E_PORT ?? 3200}`;
  delete process.env.RESEND_API_KEY;
  const schema = await import("@/lib/db/schema");
  const workerSql = postgres(E2E_DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    const db = drizzle(workerSql, { schema });
    return await db.transaction(async (tx) => fn(tx as never));
  } finally {
    await workerSql.end({ timeout: 5 });
    process.env = env;
  }
}

test.beforeAll(() => {
  sql = postgres(E2E_DATABASE_URL, { max: 2, onnotice: () => {} });
});

test.afterAll(async () => {
  if (!sql) return;
  if (savedSearchId !== null) {
    await sql`delete from job_queue where payload->>'savedSearchId' = ${savedSearchId}`;
    await sql`delete from audit_log where entity_id = ${savedSearchId}`;
  }
  if (listingId !== null) await sql`delete from listings where id = ${listingId}`;
  // Cascades to the profile, and from it to the saved search.
  await sql`delete from "user" where email = ${EMAIL}`;
  await sql.end({ timeout: 5 });
});

test.describe("saved searches", () => {
  test("flag off: no save control on /search and /account/alerts is a 404", async ({ page }) => {
    test.skip(features.savedSearches, "savedSearches is on in this build");
    await page.goto(`/search?q=${TAG}`);
    await expect(page.locator('[data-testid="result-count"]')).toBeVisible();
    await expect(page.locator('[data-testid^="save-search"]')).toHaveCount(0);
    await signUp(page);
    await expect(page.locator('[data-testid="alerts-link"]')).toHaveCount(0);
    const res = await page.goto("/account/alerts");
    expect(res?.status()).toBe(404);
  });

  test("save on /search, manage, a digest after a new listing, and the unsubscribe link", async ({ page }) => {
    test.skip(!features.savedSearches, "savedSearches is off in this build");
    test.slow();

    // Signed out, the control is a sign-in link that comes back to this search.
    await page.goto(`/search?q=${TAG}`);
    const login = page.locator('[data-testid="save-search-login"]');
    await expect(login).toBeVisible();
    await expect(login).toHaveAttribute("href", `/login?next=${encodeURIComponent(`/search?q=${TAG}`)}`);

    await signUp(page);
    await page.goto(`/search?q=${TAG}`);
    await page.locator('[data-testid="save-search"]').click();
    const saved = page.locator('[data-testid="save-search-saved"]');
    await expect(saved).toBeVisible({ timeout: 15_000 });

    // Manage: the account page links the alerts page, which lists the search.
    await saved.getByRole("link", { name: "manage" }).click();
    await page.waitForURL(/\/account\/alerts$/);
    const item = page.locator('[data-testid="saved-search"]');
    await expect(item).toHaveCount(1);
    await expect(item).toContainText(TAG);
    savedSearchId = await item.getAttribute("data-id");
    expect(savedSearchId).toBeTruthy();
    await page.goto("/account");
    await expect(page.locator('[data-testid="alerts-link"]')).toHaveAttribute("href", "/account/alerts");

    // Digests go only to a verified address; verification has its own spec.
    await sql`update "user" set email_verified = true where email = ${EMAIL}`;

    // A listing matching the search, published after it was saved.
    const [scaffold] = await sql<{ city_id: string; vertical_id: string; category_id: string }[]>`
      select c.id as city_id, cat.vertical_id, cat.id as category_id
      from categories cat
      cross join (select id from cities where is_published order by id limit 1) c
      where cat.is_active
      order by cat.id
      limit 1`;
    expect(scaffold).toBeDefined();
    listingId = randomUUID();
    await sql`insert into listings
      (id, name, slug, city_id, vertical_id, primary_category_id, status, tier, claim_status, source)
      values (${listingId}, ${`${TAG} Hall`}, ${`e2e-alert-${listingId.slice(0, 8)}`},
        ${scaffold!.city_id}, ${scaffold!.vertical_id}, ${scaffold!.category_id},
        'published', 'free', 'unclaimed', 'seed')`;
    const [listing] = await sql<{ live_at: Date }[]>`
      select coalesce(published_at, created_at) as live_at from listings where id = ${listingId}`;

    // The hourly dispatch queues exactly one digest for it.
    const { dispatchAlerts } = await import("@/worker/jobs/alerts");
    await asWorker((tx) => dispatchAlerts(tx));
    const jobs = await sql<{ id: string; status: string }[]>`
      select id, status from job_queue
      where kind = 'notify.saved_search' and payload->>'savedSearchId' = ${savedSearchId!}`;
    expect(jobs, "one notify.saved_search job must be queued").toHaveLength(1);
    expect(jobs[0]!.status).toBe("pending");

    // The notify drain delivers it. Other specs leave jobs in this database
    // and the claim takes the longest-waiting first, so ours goes to the front.
    await sql`update job_queue set run_after = to_timestamp(0) where id = ${jobs[0]!.id}`;
    const { processNotifications } = await import("@/worker/jobs/notify");
    await asWorker((tx) => processNotifications(tx));
    const [done] = await sql<{ status: string; attempts: number; last_error: string | null }[]>`
      select status, attempts, last_error from job_queue where id = ${jobs[0]!.id}`;
    expect(done?.status, `the digest job must complete (attempts ${done?.attempts}: ${done?.last_error ?? ""})`).toBe("done");
    const [after] = await sql<{ last_sent_at: Date | null; last_seen_published_at: Date; is_active: boolean }[]>`
      select last_sent_at, last_seen_published_at, is_active from saved_searches where id = ${savedSearchId!}`;
    expect(after?.last_sent_at).not.toBeNull();
    // Postgres keeps microseconds; the watermark is the millisecond a JS Date carries.
    expect(after?.last_seen_published_at.getTime()).toBe(listing!.live_at.getTime());

    // Nothing new since: the next dispatch queues nothing more.
    await asWorker((tx) => dispatchAlerts(tx, new Date(Date.now() + 8 * 86_400_000)));
    const [count] = await sql<{ n: number }[]>`
      select count(*)::int as n from job_queue where payload->>'savedSearchId' = ${savedSearchId!}`;
    expect(count?.n).toBe(1);

    // The digest's unsubscribe link: the token the worker signs, under the
    // server's key (playwright.config.ts), followed and confirmed.
    const env = { ...process.env };
    delete process.env.EMAIL_UNSUBSCRIBE_SECRET;
    process.env.BETTER_AUTH_SECRET ??= "e2e-not-a-real-secret";
    const { signUnsubscribe } = await import("@/lib/email/unsubscribe");
    const token = signUnsubscribe({ savedSearchId: savedSearchId!, email: EMAIL });
    process.env = env;
    expect(token).toBeTruthy();
    await page.goto(`/unsubscribe?t=${encodeURIComponent(token!)}`);
    await expect(page.locator('[data-testid="unsubscribe-confirm"]')).toContainText(EMAIL);
    await page.locator('[data-testid="unsubscribe-button"]').click();
    await expect(page.locator('[data-testid="unsubscribe-done"]')).toBeVisible();

    const [off] = await sql<{ is_active: boolean }[]>`select is_active from saved_searches where id = ${savedSearchId!}`;
    expect(off?.is_active).toBe(false);
    await page.goto("/account/alerts");
    await expect(page.locator('[data-testid="saved-search-off"]')).toBeVisible();
  });
});
