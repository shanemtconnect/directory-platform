import { expect, test } from "@playwright/test";
import { withE2eDb } from "./database";

/**
 * Auto city creation and the location switcher, end to end.
 *
 * The first test writes real rows — a `cities` row, its slug-registry row and a
 * pending `listings` row — into whatever database the suite is pointed at. That
 * is the point: the whole behaviour under test is "a submission for a town we
 * do not cover brings the town with it", and a mocked submission would not
 * catch a broken server action, a missing slug allocation or a city page that
 * 404s on arrival.
 *
 * The town name carries a timestamp because the slug registry is a unique
 * index: a second run with the same name would be disambiguated to
 * `<town>-2` and the test would assert against a URL it did not create.
 *
 * Rate limit: three submissions per IP per hour. Running this file more than
 * three times inside an hour against the same Redis fails on the rate-limit
 * message, which is the app behaving correctly rather than a flake.
 *
 * What it writes, it removes again in afterAll — see below. The database this
 * runs against is `directory_e2e` (scripts/e2e-db.sh), never `directory_dev`.
 */

const NEW_TOWN = `Zedbury ${Date.now()}`;
const NEW_TOWN_SLUG = NEW_TOWN.toLowerCase().replace(/[^a-z0-9]+/g, "-");

/**
 * Everything the submission test created, removed again.
 *
 * Not because the rows are harmful — the town is noindexed and the listing is
 * pending — but because they accumulate: a run a day leaves a year of Zedburys
 * in the switcher's ORDER BY, in the admin queue and in every count a later
 * assertion might make. Deleted by hand rather than by truncating, so the seed
 * data the rest of the suite asserts on is untouched.
 *
 * Order matters: listings reference the city, and the slug registry holds both
 * the city's root-scope row and the listing's row scoped to the city's id.
 */
test.afterAll(async () => {
  await withE2eDb(async (sql) => {
    const [city] = await sql`select id from cities where slug = ${NEW_TOWN_SLUG}`;
    if (!city) return;
    const cityId = city.id as string;
    await sql`delete from listings where city_id = ${cityId}`;
    await sql`delete from slugs where parent_scope = ${cityId} or entity_id = ${cityId}`;
    await sql`delete from audit_log where entity_id = ${cityId}`;
    await sql`delete from audit_log where meta->>'submittedCity' = ${NEW_TOWN}`;
    await sql`delete from cities where id = ${cityId}`;
  });
});

test.describe("a submission for a town we do not cover", () => {
  test("creates the town, renders it noindex, and keeps it out of the sitemap", async ({
    page,
    request,
  }) => {
    /*
     * There is deliberately no "it 404s first" assertion. Requesting the URL
     * before the submission writes that 404 into the ISR cache under this exact
     * path, and the cached miss is then served back for the rest of the
     * revalidate window — Next behaving correctly, and a test asserting on a
     * stale negative. The timestamp in NEW_TOWN is what guarantees the town is
     * new; the slug registry's unique index is what guarantees it stays so.
     */
    await page.goto("/add-listing");
    const form = page.locator("form").filter({ has: page.locator("#sl-city") });
    await expect(form).toBeVisible();

    const stamp = Date.now();
    await form.locator("#sl-name").fill(`Zedbury Test Rooms ${stamp}`);
    await form.locator("#sl-category").selectOption({ index: 1 });
    await form
      .locator("#sl-description")
      .fill(
        `Automated end-to-end submission (${stamp}) used to prove that a town we do ` +
          `not yet cover is created with the listing. Please ignore this record.`,
      );
    await form.locator("#sl-address").fill("1 Test Lane");
    // Any real option: the region only disambiguates towns of the same name,
    // and this one has no namesake.
    await form.locator("#sl-region").selectOption({ index: 1 });
    await form.locator("#sl-city").fill(NEW_TOWN);
    await form.locator("#sl-postcode").fill(`LS1 ${String(stamp).slice(-1)}DY`);
    /*
     * A unique phone number per run, because the submission form reuses the
     * import duplicate guard: a second submission on the same number is a
     * duplicate whatever it is called or wherever it is, so a fixed number here
     * makes the test pass once and then report "already listed" for ever.
     * 01632 96xxxx is Ofcom's reserved drama range — never a real subscriber.
     */
    await form.locator("#sl-phone").fill(`01632 96${String(stamp).slice(-4)}`);
    await form.locator("#sl-your-name").fill("Playwright Smoke");
    await form.locator("#sl-your-email").fill(`e2e+${stamp}@example.com`);

    // Filling the honeypot returns a silent fake success, which would make this
    // test pass for entirely the wrong reason.
    await expect(form.locator("#company_website")).toHaveValue("");
    await expect(form.locator('input[name="cf-turnstile-response"]')).not.toHaveValue("", {
      timeout: 15_000,
    });

    await form.locator('button[type="submit"]').click();
    await page.waitForURL(/\/add-listing\/thanks$/, { timeout: 20_000 });

    // The town now exists and its page renders.
    const cityResponse = await page.goto(`/${NEW_TOWN_SLUG}`);
    expect(cityResponse?.status(), "the auto-created town must have a page").toBe(200);
    await expect(page.locator("h1")).toContainText(NEW_TOWN);

    // And earns nothing by existing: no listings are published in it, so the
    // gate is shut and the page says so.
    const robots = page.locator('head meta[name="robots"]');
    await expect(robots).toHaveAttribute("content", /noindex/);

    // Absent from every sitemap shard — a noindexed page in the sitemap is a
    // direct contradiction of the tag on it.
    const index = await (await request.get("/sitemap.xml")).text();
    const shards = index.match(/<loc>([^<]+)<\/loc>/g) ?? [];
    for (const shard of shards) {
      const url = shard.replace(/<\/?loc>/g, "");
      const body = await (await request.get(new URL(url).pathname)).text();
      expect(body, `${url} must not advertise an unindexable town`).not.toContain(
        `/${NEW_TOWN_SLUG}`,
      );
    }
  });
});

test.describe("the location switcher", () => {
  test("offers real links to indexable cities from a category page", async ({ page, request }) => {
    await page.goto("/categories");
    const firstCategory = page.locator("main a[href^='/categories/']").first();
    const categoryPath = await firstCategory.getAttribute("href");
    expect(categoryPath, "a category link must exist to test from").toBeTruthy();

    await page.goto(categoryPath!);
    const switcher = page.locator('[data-testid="category-location-switcher"]');
    await expect(switcher, "the category page must offer a location switcher").toHaveCount(1);

    // Server-rendered links, not a select: they are in the HTML before the
    // disclosure is ever opened, which is what a crawler sees.
    const links = switcher.locator("li a");
    expect(await links.count(), "the switcher must offer somewhere to go").toBeGreaterThan(0);

    const href = await links.first().getAttribute("href");
    expect(href, "every switcher entry is a real href").toMatch(/^\/[a-z0-9-]+\/[a-z0-9-]+$/);

    // Constraint 18: the link goes to a canonical URL that already returns a
    // page, and the page it returns is its own, not a variant of this one.
    const res = await request.get(href!);
    expect(res.status(), `switcher link ${href} must not be broken`).toBe(200);
    expect(await res.text()).toContain(`<link rel="canonical" href="`);

    /*
     * The switcher may only offer INDEXABLE CITIES. The city-category page it
     * lands on is gated separately and on its own count, so it is frequently
     * noindex — that is the gate working, not a broken link. What must hold is
     * that the city half of the href has earned indexing.
     */
    const citySlug = href!.split("/")[1];
    const pillar = await request.get(`/${citySlug}`);
    expect(pillar.status(), `/${citySlug} must be a real pillar page`).toBe(200);
    expect(await pillar.text(), "the switcher must only offer indexable cities").not.toContain(
      "noindex",
    );
  });

  test("is in the header, and pre-fills the city facet on search", async ({ page }) => {
    await page.goto("/search?q=");
    const searchSwitcher = page.locator('[data-testid="search-location-switcher"]');
    await expect(searchSwitcher).toHaveCount(1);

    const facet = searchSwitcher.locator("li a").first();
    const href = await facet.getAttribute("href");
    expect(href, "the search switcher links the city facet").toMatch(/^\/search\?.*city=[a-z0-9-]+/);

    await page.goto(href!);
    const slug = new URL(href!, "http://localhost").searchParams.get("city");
    await expect(
      page.locator("#city"),
      "arriving by a switcher link must pre-select that city",
    ).toHaveValue(slug!);

    // The header carries its own compact copy, rendered server-side.
    await expect(page.locator('[data-testid="header-location-switcher"] li a').first()).toHaveAttribute(
      "href",
      /^\/[a-z0-9-]+$/,
    );
  });
});
