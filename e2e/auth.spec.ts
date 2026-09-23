import { expect, test, type Browser, type Page } from "@playwright/test";
import { withE2eDb } from "./database";

/**
 * The account lifecycle, end to end, with no mail provider.
 *
 * Nothing here reads an inbox. The two token emails are queued rather than
 * sent (lib/email/notify.ts), and no worker runs in this suite, so the queue
 * row IS the email: the verification link is read from `job_queue` and the
 * reset token from Better Auth's `verification` table. That is the same
 * mocked-mailer arrangement the unit tests use, and it means the test proves
 * the links the app generates actually work, rather than that a fake mailer
 * was called.
 *
 * Serial, on one shared page: every step below needs the account the first
 * one created and the session it left behind.
 *
 * Budgets to be aware of when re-running: /forgot-password allows five
 * requests an hour per client, and /api/auth twenty POSTs per ten minutes.
 * One run costs one of the former and five of the latter.
 */
test.describe.configure({ mode: "serial" });

const stamp = Date.now();
const EMAIL = `e2e-auth+${stamp}@example.com`;
const NAME = "Playwright Account";
const PASSWORD = `first-password-${stamp}`;
const NEW_PASSWORD = `second-password-${stamp}`;

/** Any ordinary page on the site: what a person was doing before signing in. */
const NEXT = "/search";

let page: Page;
let userId: string;

async function signIn(p: Page, password: string, path = "/login"): Promise<void> {
  await p.goto(path);
  const form = p.locator('[data-testid="login-form"]');
  await form.locator("#email").fill(EMAIL);
  await form.locator("#password").fill(password);
  await form.locator('button[type="submit"]').click();
}

async function freshPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext();
  return context.newPage();
}

test.beforeAll(async ({ browser }) => {
  page = await freshPage(browser);
});

test.afterAll(async () => {
  await page.context().close();
  // Everything the run created. `user` cascades to session, account and
  // profiles; the queue and audit rows reference the account by value only.
  await withE2eDb(async (sql) => {
    if (userId) {
      await sql`delete from job_queue where payload->>'userId' = ${userId}`;
      await sql`delete from verification where value = ${userId}`;
      await sql`delete from audit_log where actor_id in (select id from profiles where user_id = ${userId})`;
    }
    await sql`delete from "user" where email = ${EMAIL}`;
  });
});

test.describe("auth polish", () => {
  test("signing up returns to ?next=, creates a profile and queues a verification email", async () => {
    await page.goto(`/signup?next=${encodeURIComponent(NEXT)}`);
    const form = page.locator('[data-testid="signup-form"]');
    await form.locator("#name").fill(NAME);
    await form.locator("#email").fill(EMAIL);
    await form.locator("#password").fill(PASSWORD);
    await form.locator('button[type="submit"]').click();

    await page.waitForURL(`**${NEXT}`);

    const rows = await withE2eDb(async (sql) => {
      const [u] = await sql<{ id: string; email_verified: boolean }[]>`
        select id, email_verified from "user" where email = ${EMAIL}`;
      expect(u, "the account exists").toBeDefined();
      userId = u!.id;
      const profiles = await sql<{ id: string }[]>`select id from profiles where user_id = ${userId}`;
      const jobs = await sql<{ kind: string; payload: { token?: string } }[]>`
        select kind, payload from job_queue where payload->>'userId' = ${userId}`;
      return { verified: u!.email_verified, profiles, jobs };
    });

    expect(rows.verified, "sign-up does not verify the address by itself").toBe(false);
    // Requirement 4: a fresh account can act at once. The row is created
    // lazily on first read (lib/db/queries/profile.ts), and landing on a page
    // that renders the banner is enough to have caused it.
    await page.goto("/account/settings");
    await expect(page.locator('[data-testid="unverified-email-banner"]')).toBeVisible();
    const profileCount = await withE2eDb(
      async (sql) => (await sql`select 1 from profiles where user_id = ${userId}`).length,
    );
    expect(profileCount).toBe(1);

    expect(rows.jobs.map((j) => j.kind)).toEqual(["notify.auth-verify"]);
    // The queue carries the token and the user id; the worker builds the link
    // (lib/auth/links.ts) and the payload is scrubbed once it has been sent.
    expect(rows.jobs[0]!.payload.token).toMatch(/^\S{16,}$/);
    // And the queue carries an id, never the address.
    expect(JSON.stringify(rows.jobs[0]!.payload)).not.toContain(EMAIL);
  });

  test("the banner names the address and offers a resend; the link from the queue verifies it", async () => {
    await page.goto("/account/settings");
    const banner = page.locator('[data-testid="unverified-email-banner"]');
    await expect(banner).toBeVisible();
    await expect(banner.locator('[data-testid="unverified-email-address"]')).toHaveText(EMAIL);
    await expect(banner.locator('[data-testid="resend-verification"]')).toBeVisible();

    const url = await withE2eDb(async (sql) => {
      const [job] = await sql<{ payload: { token: string } }[]>`
        select payload from job_queue
        where kind = 'notify.auth-verify' and payload->>'userId' = ${userId}
        order by created_at desc limit 1`;
      // The same URL the worker builds — see verifyEmailLink in lib/auth/links.ts.
      return `/api/auth/verify-email?token=${encodeURIComponent(job!.payload.token)}&callbackURL=%2Fverify-email`;
    });

    await page.goto(url);
    await page.waitForURL("**/verify-email");
    await expect(page.locator('[data-testid="verify-email-ok"]')).toBeVisible();

    // A broken token reports itself, on our page, rather than as a bare 401.
    await page.goto("/api/auth/verify-email?token=not-a-token&callbackURL=%2Fverify-email");
    await expect(page.locator('[data-testid="verify-email-failed"]')).toBeVisible();

    await page.goto("/account/settings");
    await expect(page.locator('[data-testid="unverified-email-banner"]')).toHaveCount(0);
  });

  test("settings saves name, phone and consent, and audits the change", async () => {
    await page.goto("/account/settings");
    const form = page.locator('[data-testid="profile-form"]');
    // Shown, not editable: changing it is a different flow.
    await expect(form.locator("#pf-email")).toHaveValue(EMAIL);
    await expect(form.locator("#pf-email")).toBeDisabled();
    // Pre-filled from the name given at sign-up.
    await expect(form.locator("#pf-name")).toHaveValue(NAME);
    await expect(form.locator("#pf-marketing")).not.toBeChecked();

    await form.locator("#pf-name").fill("Playwright Renamed");
    await form.locator("#pf-phone").fill("01748 000001");
    await form.locator("#pf-marketing").check();
    await form.locator('button[type="submit"]').click();
    await expect(form.locator('[data-testid="profile-message"]')).toHaveText("Saved.");

    await page.reload();
    await expect(form.locator("#pf-name")).toHaveValue("Playwright Renamed");
    await expect(form.locator("#pf-phone")).toHaveValue("01748 000001");
    await expect(form.locator("#pf-marketing")).toBeChecked();

    const audit = await withE2eDb(async (sql) => {
      const [profile] = await sql<{ id: string }[]>`select id from profiles where user_id = ${userId}`;
      return sql<{ action: string; entity_id: string; meta: Record<string, unknown> }[]>`
        select action, entity_id, meta from audit_log
        where actor_id = ${profile!.id} and action = 'profile.updated'`;
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.meta).toMatchObject({ marketingOptIn: true, phoneSet: true });

    // The delete-account path is a mailto, not a button.
    await expect(page.locator('[data-testid="delete-account-link"]')).toHaveAttribute(
      "href",
      /^mailto:/,
    );
  });

  test("forgot-password answers the same sentence and leaves a token to read", async ({
    browser,
  }) => {
    const stranger = await freshPage(browser);
    try {
      await stranger.goto("/forgot-password");
      const form = stranger.locator('[data-testid="forgot-password-form"]');
      await form.locator("#email").fill(EMAIL);
      await form.locator('button[type="submit"]').click();
      const sent = stranger.locator('[data-testid="forgot-password-sent"]');
      await expect(sent).toBeVisible();
      await expect(sent).toContainText("If that address has an account");
    } finally {
      await stranger.context().close();
    }

    const queued = await withE2eDb(async (sql) => {
      const tokens = await sql<{ identifier: string }[]>`
        select identifier from verification
        where value = ${userId} and identifier like 'reset-password:%'`;
      const jobs = await sql<{ payload: { token: string } }[]>`
        select payload from job_queue
        where kind = 'notify.auth-reset' and payload->>'userId' = ${userId}`;
      return { tokens, jobs };
    });
    expect(queued.tokens).toHaveLength(1);
    expect(queued.jobs).toHaveLength(1);
    const token = queued.tokens[0]!.identifier.slice("reset-password:".length);
    expect(queued.jobs[0]!.payload.token).toBe(token);
  });

  test("the reset link sets a new password and signs every other session out", async ({
    browser,
  }) => {
    const url = await withE2eDb(async (sql) => {
      const [job] = await sql<{ payload: { token: string } }[]>`
        select payload from job_queue
        where kind = 'notify.auth-reset' and payload->>'userId' = ${userId}`;
      // The same URL the worker builds — see passwordResetLink in lib/auth/links.ts.
      return `/api/auth/reset-password/${encodeURIComponent(job!.payload.token)}?callbackURL=%2Freset-password`;
    });

    const stranger = await freshPage(browser);
    try {
      await stranger.goto(url);
      await stranger.waitForURL(/\/reset-password\?token=/);
      const form = stranger.locator('[data-testid="reset-password-form"]');
      await form.locator("#password").fill(NEW_PASSWORD);
      await form.locator("#confirm").fill(NEW_PASSWORD);
      await form.locator('button[type="submit"]').click();

      await stranger.waitForURL(/\/login\?reset=1$/);
      await expect(stranger.locator('[data-testid="password-reset-done"]')).toBeVisible();
    } finally {
      await stranger.context().close();
    }

    // `revokeSessionsOnPasswordReset`: the session this file has been using is
    // gone from the database. Checked there rather than by loading a page,
    // because the session cookie cache (up to a minute) can outlive the row.
    const sessions = await withE2eDb(
      async (sql) => (await sql`select 1 from session where user_id = ${userId}`).length,
    );
    expect(sessions).toBe(0);

    // Spent: /reset-password with no usable token explains itself.
    await page.goto("/reset-password");
    await expect(page.locator('[data-testid="reset-password-expired"]')).toBeVisible();
  });

  test("the old password is dead, the new one works, and ?next= is validated", async () => {
    await signIn(page, PASSWORD);
    await expect(page.locator('[data-testid="login-error"]')).toBeVisible();

    // A protocol-relative URL is the classic open redirect; it falls back.
    await signIn(page, NEW_PASSWORD, "/login?next=//evil.example/");
    await page.waitForURL("**/account");
    expect(new URL(page.url()).hostname).toBe("localhost");
  });
});
