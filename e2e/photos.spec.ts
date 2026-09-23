import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import postgres from "postgres";
import { E2E_DATABASE_URL } from "./database";
import { quietCity } from "./fixtures";

/**
 * Owner photos, end to end: an owner uploads one image, the site records it
 * as processing, and once the worker has made the sizes it appears on the
 * public page — and not before.
 *
 * R2 is not reachable from this suite and must not be: a smoke test that
 * wrote to a real bucket would leave an object behind on every run. The
 * presign step signs a POST policy offline, so throwaway credentials
 * (playwright.config.ts) are enough for the form to exist, and the browser's
 * POST to the bucket host is intercepted here and answered 204 — which is
 * exactly what R2 says when the policy accepts. What is then proved against
 * a real server, session and database is everything on our side of that
 * request: ownership, the tier cap, the key check, the row, the audit trail
 * and the cache bust.
 *
 * The worker does not run under the suite either, so its one write — the
 * derivatives blob and the image size — is made directly in the database,
 * the way the worker's own unit tests do it. The public page is ISR-cached;
 * the alt-text save is the real owner action that busts it, and is how the
 * "not before, then after" half of the assertion is possible at all.
 *
 * The account, the listing and its rows are deleted in `finally`.
 */

const DATABASE_URL = E2E_DATABASE_URL;

/** Where the suite's build was told photos are served from (playwright.config.ts). */
const MEDIA_URL = process.env.E2E_MEDIA_URL;

/** A 1x1 PNG. The bytes never reach anything that decodes them. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

async function signUp(page: Page): Promise<string> {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const email = `e2e-photos+${stamp}@example.com`;

  await page.goto("/signup");
  const form = page.locator('[data-testid="signup-form"]');
  await expect(form).toBeVisible();
  await form.locator("#name").fill("Playwright Photos");
  await form.locator("#email").fill(email);
  await form.locator("#password").fill(`pw-${stamp}-longenough`);
  await form.locator('button[type="submit"]').click();
  await page.waitForURL(/\/account$/, { timeout: 30_000 });
  return email;
}

test.describe("owner photos", () => {
  test("an uploaded photo is recorded, then shown on the public page once processed", async ({ page }) => {
    test.skip(!MEDIA_URL, "NEXT_PUBLIC_MEDIA_URL was not set for the build; the gallery cannot render");

    const city = await quietCity();
    const email = await signUp(page);
    const sql = postgres(DATABASE_URL, { max: 1 });
    const listingId = randomUUID();
    const slug = `e2e-photos-${listingId.slice(0, 8)}`;
    const listingPath = `${city.path}/${slug}`;

    try {
      // Hand the new account a published listing of its own. Direct rather
      // than through the claim flow, which has its own spec: what is under
      // test here starts at "you own this".
      const [u] = await sql<{ id: string }[]>`select id from "user" where email = ${email}`;
      expect(u).toBeDefined();
      await sql`insert into profiles (user_id) values (${u!.id}) on conflict (user_id) do nothing`;
      const [p] = await sql<{ id: string }[]>`select id from profiles where user_id = ${u!.id}`;
      const [scaffold] = await sql<{ city_id: string; vertical_id: string; category_id: string }[]>`
        select c.id as city_id, cat.vertical_id, cat.id as category_id
        from cities c
        cross join lateral (select id, vertical_id from categories where is_active order by id limit 1) cat
        where c.slug = ${city.slug}
        limit 1`;
      expect(scaffold).toBeDefined();
      await sql`insert into listings
        (id, name, slug, city_id, vertical_id, primary_category_id, status, tier, claim_status, owner_id, source)
        values (${listingId}, ${"Playwright Photos"}, ${slug},
          ${scaffold!.city_id}, ${scaffold!.vertical_id}, ${scaffold!.category_id},
          'published', 'free', 'claimed', ${p!.id}, 'seed')`;
      await sql`insert into slugs (parent_scope, slug, kind, entity_id)
        values (${scaffold!.city_id}, ${slug}, 'listing', ${listingId}) on conflict do nothing`;

      // The dashboard says photos are the next thing to do.
      await page.goto("/account");
      const card = page.locator('[data-testid="owner-listings"] > li', { hasText: "Playwright Photos" });
      await expect(card.locator('[data-testid="next-action"] a')).toHaveAttribute(
        "href", `/account/listings/${listingId}/photos`,
      );

      await page.goto(`/account/listings/${listingId}/photos`);
      const manager = page.locator('[data-testid="photo-manager"]');
      await expect(manager).toBeVisible();
      await expect(manager.locator('[data-testid="no-photos"]')).toBeVisible();
      await expect(manager.locator('[data-testid="photo-quota"]')).toContainText("0 of");
      // A site with no storage configured has no upload form: a clone proof
      // without R2 values is that site, and skipping is the honest answer.
      if ((await manager.locator('[data-testid="photo-upload-form"]').count()) === 0) {
        test.skip(true, "storage not configured on this server (R2_* unset)");
        return;
      }
      await expect(
        manager.locator('[data-testid="photo-upload-form"]'),
        "storage must be configured for this suite (see playwright.config.ts)",
      ).toBeVisible();

      // The bucket. Answered here, never reached.
      let posted: { url: string; contentType: string | null } | null = null;
      await page.route(/r2\.cloudflarestorage\.com/, async (route) => {
        const request = route.request();
        posted = { url: request.url(), contentType: request.headers()["content-type"] ?? null };
        await route.fulfill({
          status: 204,
          headers: { "access-control-allow-origin": "*" },
        });
      });

      await manager.locator("#photo-file").setInputFiles({
        name: "front.png", mimeType: "image/png", buffer: PNG,
      });
      await manager.locator('[data-testid="photo-upload-submit"]').click();
      await expect(manager.locator('[data-testid="photo-saved"]')).toBeVisible({ timeout: 30_000 });
      await expect(manager.locator('[data-testid="photo-error"]')).toHaveCount(0);

      // The browser really did POST a multipart form at the bucket host.
      expect(posted).not.toBeNull();
      expect(posted!.url).toContain("e2e-media");
      expect(posted!.contentType).toMatch(/^multipart\/form-data/);

      // One row, under this listing's own prefix, still waiting for the worker.
      const rows = await sql<{ id: string; storage_path: string; derivatives: unknown }[]>`
        select id, storage_path, derivatives from listing_images where listing_id = ${listingId}`;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.storage_path).toMatch(new RegExp(`^listings/${listingId}/photo-[a-f0-9]{16}\\.png$`));
      expect(rows[0]!.derivatives).toBeNull();
      const audits = await sql<{ action: string; ip: string | null }[]>`
        select action, ip from audit_log where entity_id = ${rows[0]!.id}::uuid`;
      expect(audits.map((a) => a.action)).toEqual(["photo.uploaded"]);
      expect(audits[0]!.ip).not.toBeNull();

      const row = manager.locator('[data-testid="photo-row"]');
      await expect(row).toHaveCount(1);
      await expect(row).toHaveAttribute("data-status", "pending");
      await expect(manager.locator('[data-testid="photo-quota"]')).toContainText("1 of");

      // Not on the public page yet: the original is never served.
      await page.goto(listingPath);
      await expect(page.locator("h1")).toHaveText("Playwright Photos");
      await expect(page.locator('[data-testid="gallery"]')).toHaveCount(0);
      const before = await page.locator('script[type="application/ld+json"]').allTextContents();
      expect(before.join("\n")).not.toContain('"image"');

      // The worker's one write, made by hand: the four sizes and the image's size.
      const imageId = rows[0]!.id;
      await sql`update listing_images set
        derivatives = ${sql.json({
          thumb: `${listingId}/${imageId}-thumb.webp`,
          card: `${listingId}/${imageId}-card.webp`,
          hero: `${listingId}/${imageId}-hero.webp`,
          full: `${listingId}/${imageId}-full.webp`,
        })},
        width = 2000, height = 1000
        where id = ${imageId}::uuid`;

      // A real owner action, which busts the listing's cached page.
      await page.goto(`/account/listings/${listingId}/photos`);
      await expect(manager.locator('[data-testid="photo-row"]')).toHaveAttribute("data-status", "live");
      await manager.locator(`#alt-${imageId}`).fill("The front of the building");
      await manager.locator(`#alt-${imageId}`).press("Enter");
      await expect(manager.locator('[data-testid="photo-saved"]')).toHaveText(/Description saved/);

      await page.goto(listingPath);
      const gallery = page.locator('[data-testid="gallery"]');
      await expect(gallery).toBeVisible();
      const hero = gallery.locator('[data-testid="gallery-hero"]');
      await expect(hero).toHaveAttribute("src", `${MEDIA_URL!.replace(/\/+$/, "")}/${listingId}/${imageId}-hero.webp`);
      await expect(hero).toHaveAttribute("alt", "The front of the building");
      await expect(hero).toHaveAttribute("width", "1200");
      await expect(hero).toHaveAttribute("height", "600");
      await expect(gallery).toContainText("1 photo");

      // And the markup now claims exactly that one image, by its largest size.
      const after = await page.locator('script[type="application/ld+json"]').allTextContents();
      const business = after.map((t) => JSON.parse(t) as Record<string, unknown>)
        .find((d) => Array.isArray(d.image));
      expect(business?.image).toEqual([`${MEDIA_URL!.replace(/\/+$/, "")}/${listingId}/${imageId}-full.webp`]);
    } finally {
      await sql`delete from listings where id = ${listingId}`;
      await sql`delete from slugs where entity_id = ${listingId}`;
      await sql`delete from audit_log where actor_id in (select id from profiles where user_id in (select id from "user" where email = ${email}))`;
      await sql`delete from "user" where email = ${email}`;
      await sql.end({ timeout: 5 });
    }
  });
});
