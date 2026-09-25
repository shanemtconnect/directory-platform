import type { Sql } from "postgres";
import { makeCategoryInCity, makeCity, makeVertical, type ListingCtx } from "./factories";
import type { TestDb } from "./db";

/**
 * Helpers for the `*.race.test.ts` files: the few tests that COMMIT rows so two
 * connections can genuinely contend. They run alone, one file at a time, under
 * `vitest.race.config.ts` — never beside the rolled-back suite, whose global
 * counts and default slugs ("venues", "leeds", "barn-venues") they would
 * otherwise disturb.
 *
 * Everything a race test commits carries a marker, so `sweepRaceRows` can find
 * it again without knowing ids: a crashed or killed run leaves nothing the next
 * run cannot clear.
 *
 * - verticals / cities / categories named `Race Vertical …`, `Race Town …`,
 *   `Race Things …` (see `raceScaffold`), and everything hanging off them;
 * - Better Auth users whose id starts `u_race_` (`RACE_USER_PREFIX`), and any
 *   user owning a listing in a race scaffold;
 * - coupons whose code starts `RACE-`;
 * - listing slugs allocated in a throwaway scope (the slug race), which point
 *   at no listing under no city.
 */

export const RACE_USER_PREFIX = "u_race_";

/**
 * A vertical, a town and a category routed in it, all under unique race names.
 * The same shape as `makeScaffold` (the town keeps a region and the defaults),
 * but nothing another test could be counting or colliding with.
 */
export async function raceScaffold(tx: TestDb, tag: string): Promise<ListingCtx> {
  const verticalId = await makeVertical(tx, `Race Vertical ${tag}`);
  const cityId = await makeCity(tx, `Race Town ${tag}`, "Race Region");
  const primaryCategoryId = await makeCategoryInCity(tx, verticalId, cityId, `Race Things ${tag}`);
  return { cityId, verticalId, primaryCategoryId };
}

/**
 * Deletes every committed row carrying a race marker, dependents first, in one
 * transaction. Idempotent: run before the race suite (a killed run's
 * leftovers), after each race file (its own rows, even when a test failed
 * half-way through setting up), and before the main suite.
 */
export const SWEEP_RACE_ROWS_SQL = String.raw`
create temp table race_v on commit drop as
  select id from verticals where name like 'Race Vertical %';
create temp table race_c on commit drop as
  select id from cities where name like 'Race Town %';
create temp table race_k on commit drop as
  select id from categories where name like 'Race Things %' or vertical_id in (select id from race_v);
create temp table race_l on commit drop as
  select id, owner_id from listings
  where city_id in (select id from race_c) or vertical_id in (select id from race_v)
     or primary_category_id in (select id from race_k);
create temp table race_p on commit drop as
  select id, user_id from profiles
  where user_id like 'u\_race\_%' or id in (select owner_id from race_l);
create temp table race_u on commit drop as
  select id from "user" where id like 'u\_race\_%' union select user_id from race_p;
create temp table race_lead on commit drop as
  select id from leads
  where city_id in (select id from race_c) or category_id in (select id from race_k)
     or listing_id in (select id from race_l) or sold_to_listing_id in (select id from race_l);
create temp table race_buy on commit drop as
  select id from lead_purchases
  where lead_id in (select id from race_lead) or listing_id in (select id from race_l)
     or user_id in (select id from race_p);
create temp table race_sub on commit drop as
  select id from subscriptions
  where listing_id in (select id from race_l) or user_id in (select id from race_p);
create temp table race_fsub on commit drop as
  select id from featured_subscriptions
  where listing_id in (select id from race_l) or user_id in (select id from race_p);
create temp table race_spot on commit drop as
  select id from featured_spots
  where area_id in (select id::text from race_c) or category_id in (select id from race_k);
create temp table race_bid on commit drop as
  select id from featured_bids
  where listing_id in (select id from race_l) or subscription_id in (select id from race_fsub)
     or spot_id in (select id from race_spot);
create temp table race_coupon on commit drop as
  select id from coupons where code like 'RACE-%';
create temp table race_ent on commit drop as
  select id::text as id from race_v union select id::text from race_c union select id::text from race_k
  union select id::text from race_l union select id::text from race_lead union select id::text from race_buy
  union select id::text from race_sub union select id::text from race_fsub union select id::text from race_bid
  union select id::text from race_spot union select id::text from race_coupon;

delete from job_queue
  where payload->>'purchaseId' in (select id::text from race_buy)
     or payload->>'listingId' in (select id::text from race_l)
     or payload->>'leadId' in (select id::text from race_lead);
delete from audit_log
  where entity_id::text in (select id from race_ent)
     or actor_id::text in (select id::text from race_p union select id from race_u);
delete from coupon_redemptions
  where coupon_id in (select id from race_coupon) or listing_id in (select id from race_l)
     or subscription_id in (select id from race_sub);
delete from coupons where id in (select id from race_coupon);
delete from featured_bids where id in (select id from race_bid);
delete from featured_subscriptions where id in (select id from race_fsub);
delete from featured_spots where id in (select id from race_spot);
delete from lead_purchases where id in (select id from race_buy);
delete from leads where id in (select id from race_lead);
delete from subscriptions where id in (select id from race_sub);
delete from listings where id in (select id from race_l);
delete from slugs
  where entity_id in (select id from race_l union select id from race_k union select id from race_c union select id from race_v)
     or parent_scope in (select id::text from race_c);
delete from slugs s
  where s.kind = 'listing' and s.slug like 'the-barn%'
    and not exists (select 1 from listings l where l.id = s.entity_id)
    and not exists (select 1 from cities c where c.id::text = s.parent_scope);
delete from categories where id in (select id from race_k);
delete from cities where id in (select id from race_c);
delete from verticals where id in (select id from race_v);
delete from "user" where id in (select id from race_u);
`;

export async function sweepRaceRows(client: Sql): Promise<void> {
  await client.begin(async (tx) => {
    await tx.unsafe(SWEEP_RACE_ROWS_SQL);
  });
}
