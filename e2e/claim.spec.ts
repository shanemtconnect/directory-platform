import { expect, test } from "@playwright/test";
import postgres from "postgres";
import { E2E_DATABASE_URL } from "./database";

/**
 * Claiming a listing by domain email, end to end.
 *
 * This is the one path on the site that hands a stranger control of a row
 * describing somebody else's business, and it is the only one that can do so
 * with no human in the loop — so it is worth proving against a real server, a
 * real session and a real database rather than a mock.
 *
 * It reads the magic token straight out of `claims`, because the mail sender
 * is deliberately `not-configured` locally (lib/email/sender.ts returns
 * `{ sent: false, reason: "not-configured" }` rather than throwing). The email
 * is not what is under test here; what the link DOES is.
 *
 * Everything it writes to the shared dev database is undone in `afterAll`:
 * the listing's website and claim columns are restored to what they were, and
 * the account, profile, claim and queued jobs it created are deleted.
 */

// The same database the server under test runs on — never directory_dev.
const DATABASE_URL = E2E_DATABASE_URL;

/** A domain nobody owns, reserved for documentation. */
const DOMAIN = "claim-e2e.example";
const BUSINESS_EMAIL = `owner@${DOMAIN}`;

const stamp = Date.now();
const ACCOUNT_EMAIL = `claim-e2e+${stamp}@example.com`;
const PASSWORD = "not-a-real-password-e2e";

interface Target {
  id: string;
  path: string;
  name: string;
  website: string | null;
  claimStatus: string;
  ownerId: string | null;
}

let sql: ReturnType<typeof postgres>;
let target: Target;
/** The claim row this spec opened, so the cleanup can name exactly its own. */
let claimId: string | null = null;

test.beforeAll(async () => {
  sql = postgres(DATABASE_URL, { max: 2 });

  const [row] = await sql<{
    id: string; name: string; slug: string; city_slug: string;
    website: string | null; claim_status: string; owner_id: string | null;
  }[]>`
    select l.id, l.name, l.slug, c.slug as city_slug, l.website, l.claim_status, l.owner_id
    from listings l
    join cities c on c.id = l.city_id
    where l.status = 'published' and l.claim_status = 'unclaimed' and l.owner_id is null
    order by l.created_at
    limit 1
  `;
  if (!row) throw new Error("The dev database has no unclaimed published listing to claim");

  target = {
    id: row.id,
    name: row.name,
    path: `/${row.city_slug}/${row.slug}`,
    website: row.website,
    claimStatus: row.claim_status,
    ownerId: row.owner_id,
  };

  // The domain the ladder will match against. Restored in afterAll.
  await sql`update listings set website = ${`https://www.${DOMAIN}`} where id = ${target.id}`;
});

test.afterAll(async () => {
  if (!sql) return;
  if (target) {
    await sql`
      update listings
      set website = ${target.website}, claim_status = ${target.claimStatus}, owner_id = ${target.ownerId}
      where id = ${target.id}
    `;
    await sql`delete from claims where listing_id = ${target.id} and business_email = ${BUSINESS_EMAIL}`;
  }
  // Only the jobs THIS run enqueued. A `kind like 'notify.claim%'` sweep would
  // quietly bin a developer's or another spec's pending claim emails on the
  // shared dev database.
  if (claimId !== null) {
    await sql`delete from job_queue where payload->>'claimId' = ${claimId}`;
  }
  // Deleting the user cascades to its profile and session rows.
  await sql`delete from "user" where email = ${ACCOUNT_EMAIL}`;
  await sql.end({ timeout: 5 });
});

test.describe("claiming a listing", () => {
  // One flow, so the steps share a session and must run in order.
  test("sign up, ask for the link, open it, and own the listing", async ({ page }) => {
    test.slow();

    await page.goto("/signup");
    const signup = page.locator('[data-testid="signup-form"]');
    await expect(signup).toBeVisible();
    await signup.locator("#name").fill("Claim E2E");
    await signup.locator("#email").fill(ACCOUNT_EMAIL);
    await signup.locator("#password").fill(PASSWORD);
    await signup.locator('button[type="submit"]').click();
    await page.waitForURL(/\/account$/, { timeout: 30_000 });

    // Nothing owned yet.
    await expect(page.locator('[data-testid="no-listings"]')).toBeVisible();

    // The public page must be how people get here: a claim flow nobody can
    // reach from the listing is a claim flow that does not exist. Went
    // missing once in a merge, hence the assertion on the href itself.
    await page.goto(target.path);
    await expect(page.locator('[data-testid="claim-link"]'))
      .toHaveAttribute("href", `/claim/${target.id}`);
    await page.locator('[data-testid="claim-link"]').click();
    await page.waitForURL(new RegExp(`/claim/${target.id}$`));
    const form = page.locator('[data-testid="claim-domain-form"]');
    await expect(form, "the domain rung must be offered for a listing with a website")
      .toBeVisible();
    await form.locator("#claim-email").fill(BUSINESS_EMAIL);
    await form.locator("#claim-name").fill("Claim E2E");
    await form.locator('button[type="submit"]').click();

    const sent = page.locator('[data-testid="claim-link-sent"]');
    await expect(sent).toBeVisible({ timeout: 20_000 });
    await expect(sent).toContainText(BUSINESS_EMAIL);

    // The token never reaches the browser — it is mailed to the business's own
    // domain — so the test reads it the way the recipient's inbox would.
    const [claim] = await sql<{ id: string; magic_token: string }[]>`
      select id, magic_token from claims
      where listing_id = ${target.id} and business_email = ${BUSINESS_EMAIL}
      order by created_at desc limit 1
    `;
    expect(claim?.magic_token, "the claim must carry a magic token").toBeTruthy();
    claimId = claim!.id;

    // Opening the link shows what is being asked for and nothing more — a mail
    // scanner following it must not be able to complete the claim.
    await page.goto(`/claim/verify/${claim!.magic_token}`);
    const confirm = page.locator('[data-testid="claim-confirm"]');
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText(target.name);

    const [stillOpen] = await sql<{ status: string }[]>`
      select status from claims
      where listing_id = ${target.id} and business_email = ${BUSINESS_EMAIL}
    `;
    expect(stillOpen?.status, "a GET on the magic link must not claim anything").toBe("pending");

    await confirm.locator('button[type="submit"]').click();
    await page.waitForURL(/\/account/, { timeout: 30_000 });
    await expect(page.locator('[data-testid="claim-outcome"]')).toContainText("yours");

    // The dashboard now lists it.
    await page.goto("/account");
    const owned = page.locator('[data-testid="owner-listings"]');
    await expect(owned).toBeVisible();
    await expect(owned).toContainText(target.name);
    await expect(page.locator('[data-testid="no-listings"]')).toHaveCount(0);

    // And the public page says so. `revalidatePath` ran in the verify route,
    // so the ISR cache holds the new answer rather than the old one.
    await page.goto(target.path);
    await expect(page.locator('[data-testid="claim-status"]')).toContainText("Claimed by owner");
    // A claimed listing no longer invites a claim.
    await expect(page.locator('[data-testid="claim-cta"]')).toHaveCount(0);

    // A second attempt on the same listing is told, rather than opening a
    // second claim on a listing that now has an owner.
    await page.goto(`/claim/${target.id}`);
    await expect(page.locator('[data-testid="claim-taken-links"]')).toBeVisible();
  });
});
