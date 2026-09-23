import { expect, test } from "@playwright/test";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "@/lib/db/schema";
import { computeAwardsForYear, awardText, type ComputeAwardsResult } from "@/lib/db/queries/awards";
import { ADMIN_VIEWER } from "@/worker/viewer";
import type { TestDb } from "@/lib/db/types";
import { E2E_DATABASE_URL } from "./database";

/**
 * Awards, end to end (Task 50): compute a year on the e2e database, then the
 * winners page renders, the winner's listing carries the pill and the
 * `award` markup, and the badge route serves the winner style — and refuses
 * it for a year that was not won.
 *
 * The contest is seeded straight into the database, like admin.spec.ts seeds
 * its pending listing: a rating comes from at least `minReviews` confirmed
 * reviews per listing, and the review form allows three per address per hour,
 * so fifteen-plus of them through the form is not a test that can run twice
 * in a day. What is under test is the seam after the ratings exist — the
 * compute, the pages, the markup and the badge — and that runs for real.
 *
 * The year is far enough out never to collide with a real run, and everything
 * this spec writes is removed at the end, ratings included.
 */

const FLAGS_ON = process.env.SITE_FLAGS_OVERRIDE === "on";

/** Whatever year is computed is what the pages and the badge have to show. */
const YEAR = 2077;

interface Contestant { id: string; slug: string; ratingAvg: string | null; ratingCount: number }
interface Contest { citySlug: string; cityName: string; categoryName: string; listings: Contestant[] }

async function withSql<T>(fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const sql = postgres(E2E_DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    return await fn(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * A town × category with at least three published listings, chosen
 * deterministically so repeated runs hit the same ISR-cached pages with the
 * same answer. Nothing here names a town or a category (see fixtures.ts).
 */
async function pickContest(): Promise<Contest> {
  return withSql(async (sql) => {
    const groups = await sql<{ city_id: string; city_slug: string; city_name: string; category_id: string; category_name: string }[]>`
      select c.id as city_id, c.slug as city_slug, c.name as city_name,
             cat.id as category_id, cat.name as category_name
      from listings l
      join cities c on c.id = l.city_id
      join categories cat on cat.id = l.primary_category_id
      where l.status = 'published'
      group by c.id, c.slug, c.name, cat.id, cat.name
      having count(*) >= 3
      order by c.slug, cat.slug
      limit 1
    `;
    const g = groups[0];
    if (!g) throw new Error("The seed has no town with three published listings in one category — awards.spec.ts needs one.");
    const rows = await sql<{ id: string; slug: string; rating_avg: string | null; rating_count: number }[]>`
      select id, slug, rating_avg, rating_count from listings
      where status = 'published' and city_id = ${g.city_id} and primary_category_id = ${g.category_id}
      order by slug limit 3
    `;
    return {
      citySlug: g.city_slug,
      cityName: g.city_name,
      categoryName: g.category_name,
      listings: rows.map((r) => ({ id: r.id, slug: r.slug, ratingAvg: r.rating_avg, ratingCount: r.rating_count })),
    };
  });
}

/** The first listing wins on average; the second has more reviews but a lower average; the third is under the floor. */
const RATINGS: [string, number][] = [["4.9", 7], ["4.4", 12], ["5.0", 2]];

async function seedRatings(contest: Contest): Promise<void> {
  await withSql(async (sql) => {
    for (const [i, l] of contest.listings.entries()) {
      const [avg, count] = RATINGS[i]!;
      await sql`update listings set rating_avg = ${avg}, rating_count = ${count} where id = ${l.id}`;
    }
  });
}

async function cleanUp(contest: Contest): Promise<void> {
  await withSql(async (sql) => {
    await sql`delete from job_queue where kind = 'notify.award.won'
      and (payload ->> 'awardId')::uuid in (select id from awards where year = ${YEAR})`;
    await sql`delete from audit_log where entity_type = 'award' and entity_id in (select id from awards where year = ${YEAR})`;
    await sql`delete from audit_log where action = 'awards.computed' and (meta ->> 'year')::int = ${YEAR}`;
    await sql`delete from awards where year = ${YEAR}`;
    for (const l of contest.listings) {
      await sql`update listings set rating_avg = ${l.ratingAvg}, rating_count = ${l.ratingCount} where id = ${l.id}`;
    }
  });
}

/** The same function the worker and the admin button call, on the same database the server reads. */
async function computeAgain(): Promise<ComputeAwardsResult> {
  const sql = postgres(E2E_DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    const db = drizzle(sql, { schema }) as unknown as TestDb;
    return await computeAwardsForYear(db, ADMIN_VIEWER, YEAR);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function compute(): Promise<string> {
  const winner = (await computeAgain()).created[0];
  if (!winner) throw new Error(`computeAwardsForYear(${YEAR}) decided nothing`);
  return winner.listingId;
}

test.describe("awards (flag on)", () => {
  test.skip(!FLAGS_ON, "the awards module is off in this build");

  let contest: Contest;
  test.beforeAll(async () => {
    contest = await pickContest();
    await cleanUp(contest);
    await seedRatings(contest);
  });
  test.afterAll(async () => {
    if (contest) await cleanUp(contest);
  });

  test("compute a year, then the winners page, the listing pill, the markup and the badge all follow", async ({ page, request }) => {
    const winnerId = await compute();
    const winner = contest.listings.find((l) => l.id === winnerId)!;
    // The method, on real rows: the best average above the floor, not the most reviews.
    expect(winner.slug).toBe(contest.listings[0]!.slug);
    const listingPath = `/${contest.citySlug}/${winner.slug}`;

    // The year's town page.
    const cityPage = await request.get(`/awards/${YEAR}/${contest.citySlug}`);
    expect(cityPage.status()).toBe(200);
    await page.goto(`/awards/${YEAR}/${contest.citySlug}`);
    await expect(page.locator("h1")).toContainText(`${YEAR}`);
    const link = page.locator('[data-testid="award-winner-link"]').first();
    await expect(link).toHaveAttribute("href", listingPath);
    await expect(page.locator('[data-testid="award-pill"]').first()).toHaveText(`Winner ${YEAR}`);

    // The year page lists the town.
    await page.goto(`/awards/${YEAR}`);
    await expect(page.locator(`a[href="/awards/${YEAR}/${contest.citySlug}"]`)).toBeVisible();

    // The winner's listing: the pill, the awards block and the `award` markup, from the same rows.
    await page.goto(listingPath);
    await expect(page.locator('[data-testid="claim-status"] [data-testid="award-pill"]')).toHaveText(`Winner ${YEAR}`);
    const expectedText = awardText({ year: YEAR, categoryName: contest.categoryName, cityName: contest.cityName });
    await expect(page.locator('[data-testid="listing-awards"]')).toContainText(expectedText);
    const jsonLd = await page.locator('script[type="application/ld+json"]').allTextContents();
    const business = jsonLd.map((t) => JSON.parse(t) as { award?: string[] }).find((d) => d.award !== undefined);
    expect(business?.award).toEqual([expectedText]);

    // The badge: the winner style renders for the year won, and only for it.
    const won = await request.get(`/badge/${winnerId}?style=award-${YEAR}`);
    expect(won.status()).toBe(200);
    expect(await won.text()).toContain(`WINNER ${YEAR}`);
    const notWon = await request.get(`/badge/${winnerId}?style=award-${YEAR + 1}`);
    expect(notWon.status()).toBe(200);
    expect(await notWon.text()).not.toContain("WINNER");
    // A listing that did not win gets the default badge under the winner style.
    const loser = contest.listings[1]!;
    expect(await (await request.get(`/badge/${loser.id}?style=award-${YEAR}`)).text()).not.toContain("WINNER");

    // The sitemap advertises the awards shard, and the shard names the town page.
    const index = await (await request.get("/sitemap.xml")).text();
    expect(index).toContain("/sitemaps/sitemap/awards.xml");
    const shard = await (await request.get("/sitemaps/sitemap/awards.xml")).text();
    expect(shard).toContain(`/awards/${YEAR}/${contest.citySlug}`);

    // A second compute for the same year decides nothing new. In this test
    // rather than its own: the suite runs files' tests in parallel, and two
    // computes racing for one slot is not the idempotence being checked.
    const again = await computeAgain();
    expect(again.created).toEqual([]);
    expect(again.skipped).toBeGreaterThanOrEqual(1);
  });

});

test.describe("awards (flag off)", () => {
  test.skip(FLAGS_ON, "this build has the awards module on");

  test("every awards URL is a 404 and nothing advertises it", async ({ request }) => {
    for (const path of ["/awards", `/awards/${YEAR}`, `/awards/${YEAR}/anywhere`]) {
      expect((await request.get(path)).status(), path).toBe(404);
    }
    const index = await (await request.get("/sitemap.xml")).text();
    expect(index).not.toContain("/sitemaps/sitemap/awards.xml");
    expect((await request.get("/sitemaps/sitemap/awards.xml")).status()).toBe(404);
  });
});
