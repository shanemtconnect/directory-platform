import { expect, test, type Page } from "@playwright/test";
import postgres from "postgres";
import { E2E_DATABASE_URL } from "./database";

/**
 * Lead credit (Task 57), end to end.
 *
 * No PayPal is involved, for the reason e2e/jobs.spec.ts gives: there are no
 * credentials here, and a suite that could create a real order would create
 * one on every run. So the real server is driven up to the hand-off — the
 * smallest pack's button, which without credentials answers "not set up" and
 * writes no order — and PayPal's half is played by recording what a settled
 * capture writes (a captured `credit_orders` row and its `topup` ledger
 * entry). The capture itself, both settle roads and the exactly-once rule are
 * proved in lib/billing/credit-topup.test.ts against a fake client.
 *
 * Flag-aware: `leadMarketplace` is a build-time constant.
 */

const PASSWORD = "not-a-real-password";

function unique(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
}

async function signUp(page: Page, email: string): Promise<void> {
  await page.goto("/signup");
  const form = page.locator('[data-testid="signup-form"]');
  await form.locator("#name").fill("Playwright Buyer");
  await form.locator("#email").fill(email);
  await form.locator("#password").fill(PASSWORD);
  await form.locator('button[type="submit"]').click();
  await page.waitForURL("**/account", { timeout: 15_000 });
}

test.describe("lead credit", () => {
  test("buy the smallest pack: the button reaches the PayPal hand-off, and the settled top-up shows on /account/credit", async ({ page }) => {
    test.setTimeout(90_000);
    const email = `${unique("e2e-credit")}@example.com`;
    const sql = postgres(E2E_DATABASE_URL, { max: 1, onnotice: () => {} });

    try {
      await signUp(page, email);
      const res = await page.goto("/account/credit");
      if (res?.status() === 404) {
        // Flag off: the page is a 404 and nothing advertises it.
        await page.goto("/account");
        await expect(page.locator('a[href="/account/credit"]')).toHaveCount(0);
        return;
      }
      expect(res?.status()).toBe(200);

      const credit = page.locator('[data-testid="account-credit"]');
      await expect(credit.locator('[data-testid="credit-balance"]')).toHaveAttribute("data-cents", "0");

      // The packs come from siteConfig.leads.packs; the smallest is first.
      const packs = credit.locator('[data-testid="credit-packs"] button');
      await expect(packs.first()).toBeVisible();
      const smallest = await packs.first().getAttribute("data-testid");
      const packCents = Number(smallest?.replace("credit-pack-", ""));
      expect(packCents).toBeGreaterThan(0);

      // No PayPal credentials in this suite: the hand-off says so, charges nothing, writes no order.
      await packs.first().click();
      await page.waitForURL("**/account/credit?topup=not-configured");
      await expect(page.locator('[data-testid="credit-topup-message"]')).toContainText("not set up");

      const [u] = await sql<{ id: string }[]>`select id from "user" where email = ${email}`;
      const [p] = await sql<{ id: string }[]>`select id from profiles where user_id = ${u!.id}`;
      const [orders] = await sql<{ n: number }[]>`select count(*)::int as n from credit_orders where user_id = ${p!.id}`;
      expect(orders?.n).toBe(0);

      // PayPal's half: what a settled capture of that pack writes.
      const orderId = unique("E2E-ORDER");
      const [order] = await sql<{ id: string }[]>`
        insert into credit_orders (user_id, pack_cents, provider_order_id, status, captured_at)
        values (${p!.id}, ${packCents}, ${orderId}, 'captured', now()) returning id`;
      await sql`insert into credit_ledger (user_id, delta_cents, kind, ref_type, ref_id, order_id, note)
        values (${p!.id}, ${packCents}, 'topup', 'credit_order', ${order!.id}, ${orderId}, 'PayPal top-up')`;

      await page.goto("/account/credit");
      await expect(page.locator('[data-testid="credit-balance"]')).toHaveAttribute("data-cents", String(packCents));
      const row = page.locator('[data-testid="credit-ledger-row"]');
      await expect(row).toHaveCount(1);
      await expect(row).toHaveAttribute("data-kind", "topup");
      await expect(row).toContainText("Top-up");

      // The account page links to it.
      await page.goto("/account");
      await expect(page.locator('a[href="/account/credit"]')).toBeVisible();
    } finally {
      await sql`delete from "user" where email = ${email}`;
      await sql.end({ timeout: 5 });
    }
  });
});
