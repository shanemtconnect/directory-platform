import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import postgres from "postgres";
import { E2E_DATABASE_URL } from "./database";

/**
 * The jobs board, end to end: a Verified owner posts free, an admin
 * approves, the public sees it and the page carries a JobPosting.
 *
 * No PayPal is involved on purpose. There are no credentials here and a
 * suite that could create a real order would create one on every run; the
 * FREE path is the one that goes all the way through the real server, and
 * the paid path stops at "not set up" (proved in lib/billing/orders.test.ts
 * against a fake client and recorded payloads).
 *
 * Flag-aware: `jobBoard` is a build-time constant, so the same spec runs
 * against both CI builds. When /jobs is a 404 the suite proves that and
 * stops; when it is a page, the round trip runs.
 *
 * Rate limit: /post-a-job allows 3 posts per IP per DAY (JOB_POST_RATE_LIMIT)
 * and this spec spends one. A fourth run inside a day against the same Redis
 * database fails on the rate-limit message — the app behaving, not a flake.
 */

const DATABASE_URL = E2E_DATABASE_URL;
const PASSWORD = "not-a-real-password";

function unique(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
}

async function signUp(page: Page, email: string): Promise<void> {
  await page.goto("/signup");
  const form = page.locator('[data-testid="signup-form"]');
  await form.locator("#name").fill("Playwright Poster");
  await form.locator("#email").fill(email);
  await form.locator("#password").fill(PASSWORD);
  await form.locator('button[type="submit"]').click();
  await page.waitForURL("**/account", { timeout: 15_000 });
}

/** Whether this build has the board at all. */
async function boardIsOn(page: Page): Promise<boolean> {
  const res = await page.goto("/jobs");
  return res?.status() === 200;
}

test.describe("jobs board", () => {
  test("flag off: /jobs, /post-a-job and /admin/jobs are 404s and nothing links to them", async ({ page }) => {
    test.skip(await boardIsOn(page), "jobBoard is on in this build");
    for (const path of ["/jobs", "/post-a-job", "/jobs/page/2"]) {
      const res = await page.goto(path);
      expect(res?.status(), path).toBe(404);
    }
    await page.goto("/");
    await expect(page.locator('a[href="/jobs"]')).toHaveCount(0);
    await expect(page.locator('a[href="/post-a-job"]')).toHaveCount(0);
  });

  test("a Verified owner posts free, an admin approves, the public sees it with JobPosting markup", async ({ page }) => {
    test.skip(!(await boardIsOn(page)), "jobBoard is off in this build");
    test.setTimeout(120_000);

    const email = `${unique("e2e-jobs")}@example.com`;
    const title = unique("Playwright vacancy");
    const listingId = randomUUID();
    const sql = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });

    try {
      // The nav advertises the board when the flag is on.
      await page.goto("/");
      await expect(page.locator('header a[href="/jobs"]').first()).toBeVisible();

      await signUp(page, email);

      // A Verified listing, handed to the account straight in the database:
      // verification is a paid-and-checked path with its own tests, and what
      // this spec proves is what the board does with one. Published, because
      // only a published listing may post free (lib/db/queries/job-board.ts).
      const [u] = await sql<{ id: string }[]>`select id from "user" where email = ${email}`;
      expect(u).toBeDefined();
      await sql`insert into profiles (user_id) values (${u!.id}) on conflict (user_id) do nothing`;
      const [p] = await sql<{ id: string }[]>`select id from profiles where user_id = ${u!.id}`;
      const [scaffold] = await sql<{ city_id: string; vertical_id: string; category_id: string }[]>`
        select c.id as city_id, cat.vertical_id, cat.id as category_id
        from categories cat
        cross join (select id from cities where is_published order by id limit 1) c
        where cat.is_active
        order by cat.id
        limit 1`;
      expect(scaffold).toBeDefined();
      await sql`insert into listings
        (id, name, slug, city_id, vertical_id, primary_category_id, status, claim_status, owner_id, source)
        values (${listingId}, ${"Playwright Verified"}, ${`e2e-verified-${listingId.slice(0, 8)}`},
          ${scaffold!.city_id}, ${scaffold!.vertical_id}, ${scaffold!.category_id},
          'published', 'verified', ${p!.id}, 'seed')`;

      // The posting page: free, with the listing picked.
      await page.goto("/post-a-job");
      const form = page.locator('[data-testid="post-job-form"]');
      await expect(form).toBeVisible();
      await expect(form.locator('[data-testid="post-job-free"]')).toBeVisible();
      await expect(form.locator('[data-testid="post-job-price"]')).toHaveCount(0);
      const picker = form.locator('[data-testid="post-job-listing"]');
      await expect(picker).toBeVisible();
      await picker.selectOption(listingId);

      await form.locator("#pj-title").fill(title);
      await form.locator("#pj-company").fill("Playwright Verified");
      await form.locator("#pj-city").selectOption(scaffold!.city_id);
      await form.locator("#pj-category").selectOption(scaffold!.category_id);
      await form.locator("#pj-description").fill(
        "A weekend coordinator to run the Saturday diary, keep the suppliers in step and greet every party at the door.",
      );
      await form.locator("#pj-budget-min").fill("18000");
      await form.locator("#pj-budget-max").fill("22000");
      await form.locator("#pj-apply-email").fill("apply@example.com");
      await form.locator("#pj-poster-name").fill("Playwright Poster");
      await form.locator("#pj-poster-email").fill(email);
      // The Turnstile testing site key always passes; wait for its token.
      await expect(form.locator('input[name="cf-turnstile-response"]')).not.toHaveValue("", { timeout: 20_000 });
      await form.locator('[data-testid="post-job-submit"]').click();
      await page.waitForURL("**/post-a-job/thanks", { timeout: 30_000 });
      await expect(page.locator('[data-testid="post-job-thanks"]')).toBeVisible();

      // Not live yet: the board does not show it.
      const [job] = await sql<{ id: string; status: string; payment_status: string; listing_id: string | null }[]>`
        select id, status, payment_status, listing_id from jobs where title = ${title}`;
      expect(job).toBeDefined();
      expect(job!.status).toBe("pending");
      expect(job!.payment_status).toBe("free");
      expect(job!.listing_id).toBe(listingId);
      const notYet = await page.goto(`/jobs/${job!.id}`);
      expect(notYet?.status()).toBe(404);

      // Promotion happens in the database: profiles.role is the only source
      // of the admin bit and nothing a client sends can influence it.
      await sql`update profiles set role = 'admin' where id = ${p!.id}`;

      await page.goto("/admin/jobs");
      const row = page.locator('[data-testid="jobs-queue-row"]', { hasText: title });
      await expect(row).toBeVisible();
      await row.locator('[data-testid="approve-job"]').click();
      await page.waitForURL("**/admin/jobs");
      await expect(page.locator('[data-testid="jobs-queue-row"]', { hasText: title })).toHaveCount(0);

      // Public, newest first, on the ISR page the action just busted.
      await page.goto("/jobs");
      const card = page.locator('[data-testid="job-card"]', { hasText: title });
      await expect(card).toBeVisible();
      await card.locator('[data-testid="job-card-link"]').click();
      await page.waitForURL(`**/jobs/${job!.id}`);

      const detail = page.locator('[data-testid="job-detail"]');
      await expect(detail).toHaveAttribute("data-open", "true");
      await expect(detail.locator('[data-testid="job-budget"]')).toContainText("18,000");
      const apply = detail.locator('[data-testid="job-apply"]');
      await expect(apply).toHaveAttribute("href", /^mailto:apply@example\.com/);

      // JobPosting, and only what the page shows.
      const scripts = await page.locator('script[type="application/ld+json"]').allTextContents();
      const posting = scripts.map((s) => JSON.parse(s) as Record<string, unknown>).find((n) => n["@type"] === "JobPosting");
      expect(posting).toBeDefined();
      expect(posting!.title).toBe(title);
      expect(typeof posting!.validThrough).toBe("string");
      expect(typeof posting!.datePosted).toBe("string");
      expect(posting!.hiringOrganization).toMatchObject({ name: "Playwright Verified" });
      expect(posting!.baseSalary).toMatchObject({ value: { minValue: 18000, maxValue: 22000 } });
      expect(posting).not.toHaveProperty("aggregateRating");

      // The apply press is counted and nothing else is kept.
      await apply.click();
      await expect.poll(async () => {
        const [j] = await sql<{ apply_count: number }[]>`select apply_count from jobs where id = ${job!.id}`;
        return j?.apply_count ?? 0;
      }, { timeout: 10_000 }).toBe(1);
      const [apps] = await sql<{ n: number }[]>`select count(*)::int as n from job_applications where job_id = ${job!.id}`;
      expect(apps?.n).toBe(0);
    } finally {
      await sql`delete from job_queue where payload->>'jobId' in (select id::text from jobs where title = ${title})`;
      await sql`delete from audit_log where entity_id in (select id from jobs where title = ${title})`;
      await sql`delete from jobs where title = ${title}`;
      await sql`delete from listings where id = ${listingId}`;
      await sql`delete from "user" where email = ${email}`;
      await sql.end({ timeout: 5 });
    }
  });
});
