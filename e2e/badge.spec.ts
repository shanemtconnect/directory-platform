import { expect, test } from "@playwright/test";
import postgres from "postgres";
import { E2E_DATABASE_URL } from "./database";

/**
 * The badge is the one thing this site serves to OTHER people's websites, so
 * the contract it has to keep is unusually strict: an image that renders
 * cross-origin, a click that lands on the listing, and neither of them able to
 * leak an unpublished row.
 *
 * Everything here runs against the seeded dev database through a production
 * build, so the ids come out of the sitemap rather than being hardcoded.
 */

/** A published listing's canonical path and id, taken from the live site. */
async function aPublishedListing(
  request: import("@playwright/test").APIRequestContext,
): Promise<{ path: string; id: string }> {
  // Via the index, not a guessed shard path: the shard URL shape belongs to
  // Next's generateSitemaps and has changed once already.
  const sitemapIndex = await request.get("/sitemap.xml");
  expect(sitemapIndex.ok()).toBe(true);
  const shard = /<loc>([^<]*listings-0[^<]*)<\/loc>/.exec(await sitemapIndex.text());
  expect(shard, "the sitemap index names a listings-0 shard").not.toBeNull();
  const index = await request.get(new URL(shard![1]!).pathname);
  expect(index.ok()).toBe(true);
  const xml = await index.text();
  const loc = /<loc>([^<]+)<\/loc>/.exec(xml);
  expect(loc, "the listings sitemap has at least one URL").not.toBeNull();
  const path = new URL(loc![1]!).pathname;

  // The listing page does not advertise its own badge (that lives on
  // /advertise/badge, keyed by ?id=), but it does render the listing id for the
  // stats beacon — a real attribute on the real page, not a database read.
  const page = await request.get(path);
  expect(page.ok()).toBe(true);
  const html = await page.text();
  const id = /data-dp-listing="([0-9a-f-]{36})"/.exec(html)?.[1] ?? null;
  // A FAILURE, not a skip: a listing page with no id on it means the stats
  // beacon is gone too, and a skipped test reports that as a green run.
  expect(id, `${path} renders its listing id`).not.toBeNull();
  return { path, id: id! };
}

test.describe("badge", () => {
  test("serves an SVG that a third-party site can embed", async ({ request }) => {
    const { path, id } = await aPublishedListing(request);

    const svg = await request.get(`/badge/${id}`);
    expect(svg.status()).toBe(200);
    expect(svg.headers()["content-type"]).toContain("image/svg+xml");
    // Embedded cross-origin by design; without this the image is blocked.
    expect(svg.headers()["access-control-allow-origin"]).toBe("*");
    expect(svg.headers()["x-content-type-options"]).toBe("nosniff");
    expect(await svg.text()).toContain("<svg");
    expect(path).toMatch(/^\//);
  });

  test("the public badge page is a worked example that never names a real listing", async ({
    request,
  }) => {
    // Static and ISR-cached, so it cannot be per-viewer: it shows the nil id
    // and sends an owner to the signed-in page for their own code.
    const { id } = await aPublishedListing(request);
    const res = await request.get(`/advertise/badge?id=${id}`);
    expect(res.ok()).toBe(true);
    const html = await res.text();
    expect(html).toContain("/badge/00000000-0000-4000-8000-000000000000");
    expect(html).not.toContain(`/badge/${id}`);
    expect(html).toContain('href="/advertise/badge/mine"');
    expect(html).not.toContain('data-testid="backlink-form"');
  });

  test("the owner page sends an anonymous visitor to sign in, and back", async ({ request }) => {
    const { id } = await aPublishedListing(request);
    const res = await request.get(`/advertise/badge/mine?id=${id}`, { maxRedirects: 0 });
    expect([302, 303, 307, 308]).toContain(res.status());
    const location = res.headers()["location"] ?? "";
    expect(location).toContain("/login");
    expect(decodeURIComponent(location)).toContain(`/advertise/badge/mine?id=${id}`);
  });

  test("404s a badge for an id that is not a published listing", async ({ request }) => {
    const nobody = await request.get("/badge/00000000-0000-4000-8000-000000000000");
    expect(nobody.status()).toBe(404);
    const rubbish = await request.get("/badge/not-a-uuid");
    expect(rubbish.status()).toBe(404);
  });

  test("the click endpoint 302s to the listing with its utm tags", async ({ request }) => {
    const { id } = await aPublishedListing(request);

    const res = await request.get(`/api/badge-click?id=${id}`, { maxRedirects: 0 });

    expect(res.status()).toBe(302);
    const location = res.headers()["location"] ?? "";
    expect(location).toContain("utm_source=badge");
    // A 301 would be cached by the browser and the second click would never
    // reach us, so the counter would stop at one per visitor for ever.
    expect(res.status()).not.toBe(301);
    expect(res.headers()["cache-control"]).toContain("no-store");
  });

  test("the click endpoint refuses a malformed or unknown id", async ({ request }) => {
    const bad = await request.get("/api/badge-click?id=not-a-uuid", { maxRedirects: 0 });
    expect(bad.status()).toBe(400);
    const missing = await request.get("/api/badge-click", { maxRedirects: 0 });
    expect(missing.status()).toBe(400);
    const unknown = await request.get(
      "/api/badge-click?id=00000000-0000-4000-8000-000000000000",
      { maxRedirects: 0 },
    );
    expect(unknown.status()).toBe(404);
  });

  test("an outreach magic link that nobody was sent is a plain 404", async ({ request }) => {
    const res = await request.get("/claim/outreach/not-a-real-token", { maxRedirects: 0 });
    expect(res.status()).toBe(404);
    // Never cached, never leaked through a referer: the token is a credential.
    expect(res.headers()["cache-control"]).toContain("no-store");
    expect(res.headers()["referrer-policy"]).toBe("no-referrer");
  });
});

/**
 * Registering where the badge was put, as the owner, end to end.
 *
 * The one write on the badge page. It runs as a real signed-in owner against
 * a real server and the e2e database, because the parts worth proving are the
 * joins between layers: the session reaching the action, the ownership check
 * inside the query answering the form, the domain rule reaching the owner as
 * a sentence, and the page showing the registered URL back afterwards.
 *
 * Ownership is assigned with one UPDATE rather than by walking the claim
 * ladder: that flow is e2e/claim.spec.ts's subject and is proven there. The
 * listing's website is pointed at a documentation domain so the domain rule
 * has something to match. Both columns are restored in `afterAll`, and the
 * badge row, audit rows and account this spec created are deleted.
 */
const DOMAIN = "badge-e2e.example";
const stamp = Date.now();
const ACCOUNT_EMAIL = `badge-e2e+${stamp}@example.com`;
const PASSWORD = "not-a-real-password-e2e";

interface Target {
  id: string;
  name: string;
  website: string | null;
  ownerId: string | null;
}

let sql: ReturnType<typeof postgres>;
let owned: Target;
/** A second published listing this account does NOT own. */
let notOwned: { id: string };
let profileId: string | null = null;

test.describe("badge backlink registration", () => {
  test.beforeAll(async () => {
    sql = postgres(E2E_DATABASE_URL, { max: 2, onnotice: () => {} });
    const rows = await sql<{ id: string; name: string; website: string | null; owner_id: string | null }[]>`
      select id, name, website, owner_id
      from listings
      where status = 'published' and owner_id is null
      order by created_at
      limit 2
    `;
    if (rows.length < 2) throw new Error("The e2e database needs two unowned published listings");
    owned = { id: rows[0]!.id, name: rows[0]!.name, website: rows[0]!.website, ownerId: rows[0]!.owner_id };
    notOwned = { id: rows[1]!.id };
  });

  test.afterAll(async () => {
    if (!sql) return;
    if (owned) {
      await sql`update listings set website = ${owned.website}, owner_id = ${owned.ownerId} where id = ${owned.id}`;
      await sql`delete from badges where listing_id = ${owned.id} and backlink_url like ${`%${DOMAIN}%`}`;
      // The check job never ran under Playwright, so the boost is untouched;
      // the audit rows are this account's and go with it.
      if (profileId !== null) {
        await sql`delete from audit_log where actor_id = ${profileId} and action = 'badge.backlink.register'`;
      }
    }
    // Deleting the user cascades to its profile and session rows.
    await sql`delete from "user" where email = ${ACCOUNT_EMAIL}`;
    await sql.end({ timeout: 5 });
  });

  test("a signed-in owner says where the badge is, sees it, and a non-owner gets the public page", async ({
    page,
  }) => {
    test.slow();

    await page.goto("/signup");
    const signup = page.locator('[data-testid="signup-form"]');
    await expect(signup).toBeVisible();
    await signup.locator("#name").fill("Badge E2E");
    await signup.locator("#email").fill(ACCOUNT_EMAIL);
    await signup.locator("#password").fill(PASSWORD);
    await signup.locator('button[type="submit"]').click();
    await page.waitForURL(/\/account$/, { timeout: 30_000 });

    // Signed in but owning nothing: the owner page has nothing to show and
    // says so, and a listing id it does not own is answered with the public
    // page rather than a 404 that confirms the row.
    await page.goto("/advertise/badge/mine");
    await expect(page.locator('[data-testid="no-listings"]')).toBeVisible();
    await page.goto(`/advertise/badge/mine?id=${notOwned.id}`);
    await page.waitForURL(/\/advertise\/badge$/);
    await expect(page.locator('[data-testid="backlink-form"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="my-badge-link"]')).toBeVisible();

    // Hand the account one listing. /account ran ensureProfile on sign-up.
    const [profile] = await sql<{ id: string }[]>`
      select p.id from profiles p join "user" u on u.id = p.user_id where u.email = ${ACCOUNT_EMAIL}
    `;
    expect(profile?.id, "sign-up created a profile").toBeTruthy();
    profileId = profile!.id;
    await sql`
      update listings set owner_id = ${profileId}, website = ${`https://www.${DOMAIN}/`}
      where id = ${owned.id}
    `;

    // The owner portal is how people get here.
    await page.goto(`/account/listings/${owned.id}`);
    await expect(page.locator('[data-testid="badge-link"]'))
      .toHaveAttribute("href", `/advertise/badge/mine?id=${owned.id}`);
    await page.locator('[data-testid="badge-link"]').click();
    await page.waitForURL(new RegExp(`/advertise/badge/mine\\?id=${owned.id}$`));

    // The real snippet, and nothing registered yet.
    await expect(page.locator("main")).toContainText(owned.name);
    // The snippet names the real listing, not the placeholder.
    await expect(page.locator("main")).toContainText(`/badge/${owned.id}`);
    await expect(page.locator("main")).not.toContainText("00000000-0000-4000-8000-000000000000");
    await expect(page.locator('[data-testid="backlink-status"]'))
      .toHaveAttribute("data-state", "unregistered");

    const form = page.locator('[data-testid="backlink-form"]');
    await expect(form).toBeVisible();

    // A page on somebody else's site is refused, in words, naming the domain.
    await form.locator("#backlink-url").fill("https://somebody-else.example/partners");
    await form.locator('button[type="submit"]').click();
    const error = page.locator('[data-testid="backlink-error"]');
    await expect(error).toBeVisible({ timeout: 20_000 });
    await expect(error).toContainText(DOMAIN);
    await expect(page.locator('[data-testid="backlink-status"]'))
      .toHaveAttribute("data-state", "unregistered");

    // A page on the listing's own domain is registered and shown back.
    const url = `https://${DOMAIN}/about-us`;
    await form.locator("#backlink-url").fill(url);
    await form.locator('button[type="submit"]').click();
    await expect(page.locator('[data-testid="backlink-saved"]')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('[data-testid="backlink-saved"]')).toContainText(url);

    await page.reload();
    const status = page.locator('[data-testid="backlink-status"]');
    await expect(status).toHaveAttribute("data-state", "pending");
    await expect(page.locator('[data-testid="backlink-registered-url"]')).toHaveText(url);
    await expect(page.locator('[data-testid="backlink-check-now"]')).toBeVisible();

    const [row] = await sql<{ backlink_url: string; backlink_verified: boolean }[]>`
      select backlink_url, backlink_verified from badges where listing_id = ${owned.id}
    `;
    expect(row).toMatchObject({ backlink_url: url, backlink_verified: false });
    const [audit] = await sql<{ n: string }[]>`
      select count(*)::text as n from audit_log
      where actor_id = ${profileId} and action = 'badge.backlink.register' and entity_id = ${owned.id}
    `;
    expect(Number(audit?.n)).toBe(1);
  });
});
