import { siteConfig } from "@/config/site.config";
import { countryProfile } from "@/lib/geo/countries";
import { PER_PAGE } from "@/lib/db/queries/listings";
import { withE2eDb } from "./database";

/**
 * What the suite asserts against, discovered from the site under test.
 *
 * Nothing in e2e/ may name a town, a category, a listing or a keyword. The
 * suite runs against whatever niche the repo has been cloned into —
 * `scripts/verify-clone.sh` builds a second directory from an answers file and
 * runs every spec here against it — and a spec that says "richmond" or "barn"
 * passes on the template and fails on every clone, which proves nothing about
 * either. Every fixture below is read from the database the server is serving
 * or from `siteConfig`, the same two places the pages themselves read from.
 *
 * Read-only. Specs that write (a submission, a report, an account) still go
 * through the real forms and clean up after themselves; this file only picks
 * which existing row they aim at.
 *
 * What the seed data has to provide for the whole suite to run, and which spec
 * needs it:
 *   - one published city with MORE than `PER_PAGE` listings (pagination,
 *     routing, canonical, chrome: a real page 2);
 *   - one published city with a region and few listings (admin, admin-trust:
 *     an approved submission must land on page 1 of its town);
 *   - a keyword in some listing names but not all (search);
 *   - at least two unowned published listings (badge, claim).
 * Each helper throws a sentence naming the gap rather than letting the
 * assertion downstream fail on a `null`.
 */

export interface CityFixture {
  /** The URL segment, e.g. `richmond-north-yorkshire`. */
  readonly slug: string;
  /** The name as rendered in the h1 and typed into the submission form. */
  readonly name: string;
  /** Disambiguation only; the region `<select>` on /add-listing lists these. */
  readonly region: string | null;
  readonly listings: number;
  /** `/${slug}` — what `page.goto` wants. */
  readonly path: string;
}

interface CityRow {
  slug: string;
  name: string;
  region: string | null;
  listings: number;
}

const toFixture = (row: CityRow): CityFixture => ({ ...row, path: `/${row.slug}` });

/** The same profile the forms validate against. */
export const country = countryProfile(siteConfig.country);

/** Memoised per worker: the rows do not change under the suite. */
const memo = new Map<string, Promise<unknown>>();
function once<T>(key: string, load: () => Promise<T>): Promise<T> {
  let hit = memo.get(key) as Promise<T> | undefined;
  if (hit === undefined) {
    hit = load();
    memo.set(key, hit);
  }
  return hit;
}

/** Counted live rather than trusting `cities.listing_count`, which a spec's cleanup may lag. */
const CITY_COUNTS = `
  select c.slug, c.name, c.region, count(l.id)::int as listings
  from cities c
  join listings l on l.city_id = c.id and l.status = 'published'
  where c.is_published
  group by c.id
`;

/** The city with the most published listings — the one that paginates, if any does. */
export function busiestCity(): Promise<CityFixture> {
  return once("busiest", async () => {
    const [row] = await withE2eDb(
      (sql) => sql.unsafe<CityRow[]>(`${CITY_COUNTS} order by listings desc, c.slug limit 1`),
    );
    if (!row) throw new Error("The e2e database has no published city with a published listing.");
    return toFixture(row);
  });
}

/**
 * A city with a real `/page/2`. The suite cannot prove pagination is
 * server-rendered on a site where nothing paginates, so this is a requirement
 * on the seed rather than something to skip past.
 */
export async function paginatingCity(): Promise<CityFixture> {
  const city = await busiestCity();
  if (city.listings <= PER_PAGE) {
    throw new Error(
      `No city paginates: the busiest, ${city.name}, holds ${city.listings} published ` +
        `listings and a page holds ${PER_PAGE}. Seed one city with more than ${PER_PAGE}.`,
    );
  }
  return city;
}

/**
 * A city with a region and as few listings as possible, so a submission
 * approved into it is on the first page of the town wherever the daily
 * shuffle puts it. The region matters: the submission form resolves a typed
 * town against the region picked from a `<select>`, and a city with none
 * cannot be chosen there.
 */
/**
 * A town that is neither the busiest nor the quietest: the second-quietest
 * with a region. Specs that create premium fixtures use it, because a premium,
 * verified fixture sorts FIRST in its town's grid, and every spec that "clicks
 * the first listing" derives its town from `busiestCity()` — a fixture there
 * becomes their listing and vanishes under them when the fixture is cleaned up.
 */
export function sideCity(): Promise<CityFixture> {
  return once("side", async () => {
    const rows = await withE2eDb(
      (sql) =>
        sql.unsafe<CityRow[]>(
          `${CITY_COUNTS} having c.region is not null order by listings asc, c.slug limit 2`,
        ),
    );
    const row = rows[1] ?? rows[0];
    if (!row) throw new Error("The e2e database has no published city with a region.");
    return toFixture(row);
  });
}

export function quietCity(): Promise<CityFixture> {
  return once("quiet", async () => {
    const [row] = await withE2eDb(
      (sql) =>
        sql.unsafe<CityRow[]>(
          `${CITY_COUNTS} having c.region is not null order by listings asc, c.slug limit 1`,
        ),
    );
    if (!row) throw new Error("The e2e database has no published city with a region.");
    if (row.listings >= PER_PAGE) {
      throw new Error(
        `Every city already fills a page (${row.name} is the quietest at ${row.listings}); ` +
          "an approved submission could land on page 2 and the admin specs could not find it.",
      );
    }
    return toFixture(row);
  });
}

/** `/${city}/${listing}` of some published listing, for the routes that need one to exist. */
export function anyListingPath(): Promise<string> {
  return once("listing", async () => {
    const [row] = await withE2eDb(
      (sql) => sql<{ city: string; slug: string }[]>`
        select c.slug as city, l.slug
        from listings l join cities c on c.id = l.city_id
        where l.status = 'published' and c.is_published
        order by l.created_at, l.slug limit 1
      `,
    );
    if (!row) throw new Error("The e2e database has no published listing.");
    return `/${row.city}/${row.slug}`;
  });
}

/** The slug of an active category that has at least one published listing. */
export function anyCategorySlug(): Promise<string> {
  return once("category", async () => {
    const [row] = await withE2eDb(
      (sql) => sql<{ slug: string }[]>`
        select cat.slug from categories cat
        where cat.is_active
          and exists (select 1 from listings l where l.primary_category_id = cat.id and l.status = 'published')
        order by cat.sort_order, cat.slug limit 1
      `,
    );
    if (!row) throw new Error("The e2e database has no active category with a published listing.");
    return row.slug;
  });
}

/**
 * A word that narrows /search: it matches some published listings and not all
 * of them, by the same `ilike` over name and descriptions the page runs.
 * Preferring the most common such word keeps the match count well clear of
 * zero if a spec's cleanup is a listing behind.
 */
export function narrowingKeyword(): Promise<string> {
  return once("keyword", async () => {
    const [row] = await withE2eDb(
      (sql) => sql<{ word: string }[]>`
        with published as (
          select name, coalesce(short_description, '') as short_description,
                 coalesce(description, '') as description
          from listings where status = 'published'
        ),
        words as (
          select distinct lower(w) as word
          from published, regexp_split_to_table(name, '\\s+') as w
          where w ~ '^[A-Za-z]{4,}$'
        ),
        hits as (
          select word,
                 (select count(*) from published p
                  where p.name ilike '%' || word || '%'
                     or p.short_description ilike '%' || word || '%'
                     or p.description ilike '%' || word || '%') as n
          from words
        )
        select word from hits
        where n > 0 and n < (select count(*) from published)
        order by n desc, word limit 1
      `,
    );
    if (!row) {
      throw new Error("No word in any published listing name narrows the search — seed more varied names.");
    }
    return row.word;
  });
}

/** A postcode / ZIP the submission form accepts for this site's country. */
export function validPostcode(): string {
  return country.postcodeExample;
}

/**
 * A phone number in the country's reserved-for-fiction range that no earlier
 * run used: the last four digits of the profile's example are replaced, so
 * "01632 960000" becomes "01632 96NNNN" and "(555) 010-0000" becomes
 * "(555) 010-NNNN". Needed because the submission form reuses the import
 * duplicate guard, which matches on normalised digits across every listing —
 * a fixed number makes the second run of a spec a duplicate of the first.
 *
 * The first of the four is drawn from 2–9: the shipped seed sets number their
 * rows upward from the example itself (`…0000`, `…0100`), so staying above
 * 2000 keeps a fresh draw clear of a seeded listing's number.
 */
export function uniquePhone(): string {
  const chars = [...country.reservedPhoneExample];
  let left = 4;
  for (let i = chars.length - 1; i >= 0 && left > 0; i--) {
    if (/\d/.test(chars[i]!)) {
      chars[i] = String(left === 1 ? 2 + Math.floor(Math.random() * 8) : Math.floor(Math.random() * 10));
      left--;
    }
  }
  return chars.join("");
}

/**
 * A number a LEAD may carry (Task 56). `uniquePhone()` deliberately draws
 * from the fiction range, which the lead rules refuse (lib/geo/phone.ts
 * `FICTIONAL_RANGES`), so a spec that expects a lead to be created needs a
 * real-shaped number outside it. GB: 01632 97NNNN — the 01632 area code is
 * unallocated outside Ofcom's 960xxx drama block, so this is nobody's line.
 * Other countries would need their own unallocated block here.
 */
export function leadPhone(): string {
  const n4 = () => String(Math.floor(Math.random() * 10_000)).padStart(4, "0");
  switch (country.code) {
    case "GB":
      return `01632 97${n4()}`;
    case "US":
      // 555-01XX is the fiction block the rules refuse; 555-0200 upward is
      // reserved for information services and assigned to nobody.
      return `(202) 555-${String(200 + Math.floor(Math.random() * 9_800)).padStart(4, "0")}`;
    case "AU":
      // 02 5550 xxxx is the ACMA drama block; 5551 is outside it.
      return `02 5551 ${n4()}`;
    default:
      throw new Error(`leadPhone() has no unallocated block for ${country.code}; add one in e2e/fixtures.ts`);
  }
}
