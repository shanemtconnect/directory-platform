import { expect, test, type Page } from "@playwright/test";
import { normaliseName } from "@/lib/import/guardrails";
import { withE2eDb } from "./database";

/**
 * The trust round trip: a visitor reports a listing and asks for it to come
 * down, an admin works both queues, and the listing leaves the open web.
 *
 * This is the one path on the site with a regulator at the end of it, and it
 * spans four things that only meet in a running server — the public forms, the
 * two admin queues, the server actions behind their buttons, and the ISR cache
 * the removed page is sitting in. Unit tests cover each half; nothing but this
 * covers the join.
 *
 * The listing under test is created and destroyed by this spec. It is NOT one
 * of the seeded ones: a takedown removes a row, writes a suppression against
 * its name and recomputes its town's indexing, and doing that to shared seed
 * data would leave `directory_e2e` a little more wrong after every run.
 *
 * Rate limits (reports 5/IP/hour, removals 3/IP/hour) do not bite here: the
 * suite talks to the standalone server directly, so there is no
 * X-Forwarded-For, `rateLimitSubject` has nothing to count against, and the
 * limiter passes without counting. Behind a proxy this spec would spend one of
 * each.
 *
 * The one limiter that does bite is Better Auth's own in-memory sign-up rule
 * (lib/auth/server.ts), and only when the WHOLE suite signs up at once — every
 * spec creates its own account, in parallel. Run on its own this spec signs up
 * twice. A "Too many requests" alert on /signup is that, not Redis.
 */

/**
 * Richmond in Greater London, not the North Yorkshire one — the same town
 * e2e/admin.spec.ts uses, and for the same reason: it holds a single seeded
 * listing, so an approved submission is on the first page of it rather than
 * somewhere among twenty-six. Both specs only ever assert on their own
 * listing's name, so they can run beside each other.
 */
const TOWN = { slug: "richmond" };

const PASSWORD = "not-a-real-password";

function unique(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
}

/** Ofcom's reserved drama range, so it can never reach a real line. */
function uniquePhone(): string {
  return `020 7946 ${String(Math.floor(Math.random() * 10_000)).padStart(4, "0")}`;
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
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
 * should not be one: `profiles.role` is the only source of the admin bit, and
 * nothing a client sends can influence it. Signing up does not create the
 * profile row — `ensureProfile` does, on first write — so this inserts it.
 */
async function promoteToAdmin(email: string): Promise<void> {
  await withE2eDb(async (sql) => {
    const rows = await sql<{ id: string }[]>`select id from "user" where email = ${email} limit 1`;
    const userId = rows[0]?.id;
    if (!userId) throw new Error(`No account was created for ${email}`);
    await sql`
      insert into profiles (user_id, role) values (${userId}, 'admin')
      on conflict (user_id) do update set role = 'admin'
    `;
  });
}

/**
 * Files a pending listing, which the spec then approves through the console.
 *
 * It goes in as `pending` rather than straight to `published` on purpose: the
 * approval is what revalidates the town page, so afterwards the listing is
 * genuinely ON the cached page it later has to disappear from. A row inserted
 * as published would be absent from the cache the whole time, and "it is gone"
 * would pass for a takedown that did nothing.
 *
 * /add-listing is not used for this: it allows three submissions per IP per
 * hour and two other specs already spend from that budget.
 */
async function seedPendingListing(name: string): Promise<{ id: string; slug: string }> {
  const slug = slugify(name);
  return await withE2eDb(async (sql) => {
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
        address_line1, postcode, phone, email, description, submitted_by_email, custom_fields
      ) values (
        ${seed.id}, ${name}, ${slug}, ${seed.city_id}, ${seed.vertical_id}, ${seed.category_id},
        'pending', 'free', 'unclaimed', 'public',
        '1 Test Lane', 'TW9 1AA', ${uniquePhone()}, ${`${unique("listing")}@example.com`},
        'Seeded by the trust end-to-end test to exercise the report and removal queues.',
        ${`${unique("submitter")}@example.com`},
        ${sql.json({ submission: { submitterName: "Playwright Submitter", requestedTier: "free" } })}
      )
    `;
    await sql`
      insert into slugs (parent_scope, slug, kind, entity_id)
      values (${seed.city_id}, ${slug}, 'listing', ${seed.id})
      on conflict do nothing
    `;
    return { id: seed.id, slug };
  });
}

/**
 * Takes the listing and everything hung off it back out again, then puts the
 * town's counters back where they were.
 *
 * `reports` and `removal_requests` cascade from the listing; `suppressions` has
 * no foreign key by design — it is meant to outlive the row it describes —
 * so it has to go explicitly, or the next seed of this database would find the
 * name suppressed.
 */
async function cleanUp(name: string): Promise<void> {
  await withE2eDb(async (sql) => {
    await sql`delete from suppressions where name_normalised = ${normaliseName(name)}`;
    const rows = await sql<{ city_id: string }[]>`
      delete from listings where name = ${name} returning city_id
    `;
    const cityId = rows[0]?.city_id;
    if (cityId === undefined) return;
    await sql`
      update cities c
      set listing_count = counted.n,
          is_indexable = counted.n >= 3 and coalesce(btrim(c.intro_html), '') <> ''
      from (
        select count(*)::int as n from listings
        where city_id = ${cityId} and status = 'published'
      ) counted
      where c.id = ${cityId}
    `;
  });
}

async function waitForTurnstile(page: Page): Promise<void> {
  await expect(page.locator('input[name="cf-turnstile-response"]'))
    .not.toHaveValue("", { timeout: 15_000 });
}

/** Polls the town page, which is ISR-cached, until it says what it should. */
async function expectOnTownPage(page: Page, name: string, present: boolean): Promise<void> {
  await expect
    .poll(
      async () => {
        await page.goto(`/${TOWN.slug}`, { waitUntil: "domcontentloaded" });
        return await page.locator('[data-testid="listing-grid"]').getByText(name).count();
      },
      {
        timeout: 60_000,
        message: present
          ? "the approved listing must appear on its town page"
          : "the removed listing must be gone from its town page",
      },
    )
    .toBe(present ? 1 : 0);
}

test.describe("the trust queues", () => {
  test("a report and a removal request are raised, worked and the listing comes down", async ({
    page,
  }) => {
    const email = `${unique("admin")}@example.com`;
    const listingName = `E2E ${unique("Retreat")}`;
    const reporterEmail = `e2e+report${Date.now()}@example.com`;
    const requesterEmail = `e2e+removal${Date.now()}@example.com`;

    await signUp(page, email);
    await promoteToAdmin(email);
    const listing = await seedPendingListing(listingName);

    try {
      // -------------------------------------------------- publish it first
      await page.goto("/admin/submissions");
      await page.locator('[data-testid="submission-queue"] a', { hasText: listingName }).click();
      await page.waitForURL(/\/admin\/submissions\/[0-9a-f-]{36}$/);
      await page.locator('[data-testid="approve-submit"]').click();
      await page.waitForURL("**/admin/submissions", { timeout: 20_000 });
      await expectOnTownPage(page, listingName, true);

      // ------------------------------------------ a visitor reports it
      const listingPath = `/${TOWN.slug}/${listing.slug}`;
      await page.goto(listingPath);
      const links = page.locator('[data-testid="correction-links"]');
      await links.getByRole("link", { name: "Report incorrect information" }).click();
      await page.waitForURL(/\/report\/[0-9a-f-]{36}$/);

      const reportForm = page.locator('[data-testid="report-form"]');
      await reportForm.locator("#rp-closed").check();
      await reportForm.locator("#rp-detail").fill("This one shut last spring — the sign is gone.");
      await reportForm.locator("#rp-email").fill(reporterEmail);
      await expect(reportForm.locator("#company_website")).toHaveValue("");
      await waitForTurnstile(page);
      await reportForm.locator('button[type="submit"]').click();
      await page.waitForURL(/\/report\/[0-9a-f-]{36}\/thanks$/, { timeout: 20_000 });

      // ------------------------------- and then asks for it to come down
      await page.goto(listingPath);
      await links.getByRole("link", { name: "Request removal" }).click();
      await page.waitForURL(/\/remove\/[0-9a-f-]{36}$/);

      const removalForm = page.locator('[data-testid="removal-form"]');
      await removalForm.locator("#rm-name").fill("Dana Whitfield");
      await removalForm.locator("#rm-email").fill(requesterEmail);
      await removalForm.locator("#rm-subject").check();
      await removalForm.locator("#rm-reason").fill("The listing is about me and I want it gone.");
      await expect(removalForm.locator("#company_website")).toHaveValue("");
      await waitForTurnstile(page);
      await removalForm.locator('button[type="submit"]').click();
      await page.waitForURL(/\/remove\/[0-9a-f-]{36}\/thanks$/, { timeout: 20_000 });

      // The deadline is five WORKING days out, so the only way to see the
      // overdue marker inside a test run is to move the deadline. The row was
      // created by the app; this moves nothing else about it.
      await withE2eDb(async (sql) => {
        await sql`
          update removal_requests set due_at = now() - interval '3 days'
          where requester_email = ${requesterEmail}
        `;
      });

      // ------------------------------------------ the dashboard counts both
      await page.goto("/admin");
      const counts = page.locator('[data-testid="admin-counts"]');
      await expect(counts.locator('a[href="/admin/reports"]')).toBeVisible();
      await expect(counts.locator('a[href="/admin/removals"]')).toBeVisible();
      await expect(page.locator('[data-testid="admin-nav"] a[href="/admin/reports"]')).toBeVisible();
      await expect(page.locator('[data-testid="admin-nav"] a[href="/admin/removals"]')).toBeVisible();

      // ----------------------------------------------------- the report queue
      await counts.locator('a[href="/admin/reports"]').click();
      await page.waitForURL("**/admin/reports");
      const reportCard = page.locator('[data-testid="report-queue"] > li').filter({ hasText: listingName });
      await expect(reportCard).toHaveCount(1);
      // Everything an admin needs to judge it without opening anything else.
      await expect(reportCard).toContainText("closed");
      await expect(reportCard).toContainText("the sign is gone");
      await expect(reportCard).toContainText(reporterEmail);
      await expect(reportCard.locator(`a[href="/admin/submissions/${listing.id}"]`)).toBeVisible();

      await reportCard.locator('[data-testid="report-actioned"]').click();
      await expect(
        page.locator('[data-testid="report-queue"] > li').filter({ hasText: listingName }),
      ).toHaveCount(0, { timeout: 20_000 });

      // ---------------------------------------------------- the removal queue
      await page.goto("/admin/removals");
      const removalCard = page.locator('[data-testid="removal-queue"] > li').filter({ hasText: listingName });
      await expect(removalCard).toHaveCount(1);
      await expect(removalCard).toContainText("Dana Whitfield");
      await expect(removalCard).toContainText(requesterEmail);
      await expect(removalCard).toContainText("The listing is about me personally");
      await expect(removalCard).toContainText("I want it gone");
      // Backdated above: a request past its deadline must say so.
      await expect(removalCard.locator('[data-testid="removal-overdue"]')).toBeVisible();

      await removalCard.locator('[data-testid="removal-action"]').click();
      await expect(
        page.locator('[data-testid="removal-queue"] > li').filter({ hasText: listingName }),
      ).toHaveCount(0, { timeout: 30_000 });

      // ------------------------------------------------ and it is off the web
      await expectOnTownPage(page, listingName, false);
      expect((await page.goto(listingPath))?.status()).toBe(404);

      // The half people forget: without the suppression the next import of the
      // same public register puts the listing straight back and the person has
      // to ask us twice.
      const suppressions = await withE2eDb(
        async (sql) =>
          await sql<{ reason: string | null }[]>`
            select reason from suppressions where name_normalised = ${normaliseName(listingName)}
          `,
      );
      expect(suppressions, "a suppression must outlive the listing it removed").toHaveLength(1);

      // Both decisions are on the record, with the moderator resolved to a person.
      await page.goto("/admin/audit");
      const audit = page.locator('[data-testid="audit-table"]');
      await expect(audit).toContainText("report.actioned");
      await expect(audit).toContainText("removal_request.actioned");
    } finally {
      await cleanUp(listingName);
    }
  });

  test("neither queue exists for a signed-in user who is not an admin", async ({ page }) => {
    await signUp(page, `${unique("plain")}@example.com`);

    for (const path of ["/admin/reports", "/admin/removals"]) {
      const response = await page.goto(path);
      // 404, not 403: confirming the console exists tells an attacker where to aim.
      expect(response?.status(), `${path} must 404 for a non-admin`).toBe(404);
      await expect(page.locator('[data-testid="admin-nav"]')).toHaveCount(0);
    }
  });
});
