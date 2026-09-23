import { siteUrl } from "@/lib/schema/builders";
import { now } from "@/lib/clock";
import { badgesDueForCheck, recordBacklinkCheck } from "@/lib/db/queries/badges";
import { listingPaths } from "@/lib/db/queries/paths";
import { checkBacklink, type BacklinkFetch, type Resolver } from "@/lib/badge/backlink";
import { ADMIN_VIEWER } from "../viewer";
import type { Db } from "@/lib/db/client";

/**
 * Weekly for a verified badge, daily for one we have never seen work.
 *
 * The badge buys a listing +5 rank_boost, so the link has to be real and it
 * has to still be there. Owners redesign sites, agencies delete footers, and a
 * boost granted once and never re-checked is a ranking signal we are lying to
 * ourselves about.
 *
 * Every fetch goes through the SSRF guard in lib/badge/backlink.ts: the URL
 * was typed into a form by a stranger, which makes this the one outbound
 * request in the application that an attacker chooses the destination of.
 */

/** The links that count: this listing's canonical URL, or the site root. */
export function backlinkTargets(listing: { citySlug: string; listingSlug: string }): string[] {
  return [siteUrl(`/${listing.citySlug}/${listing.listingSlug}`), siteUrl("/")];
}

export interface BacklinkCheckDeps {
  at?: Date;
  limit?: number;
  resolve?: Resolver;
  /**
   * The pinned type, never `typeof fetch`: Node's bundled fetch ignores an
   * npm-undici Agent, so a caller passing it would skip the dispatcher the
   * DNS pin lives in. Production passes nothing and gets undici's own.
   */
  fetchImpl?: BacklinkFetch;
}

export interface BacklinkCheckReport {
  checked: number;
  verified: number;
  failed: number;
  /**
   * The ISR pages a boost granted or withdrawn left stale — only on a
   * transition, since an unchanged boost changes no ranking. Handed back for
   * `worker/index.ts` to send after the lock's transaction commits; see
   * lib/revalidate/client.ts for why not from in here.
   */
  revalidate: string[];
}

export async function checkBadgeBacklinks(
  db: Db,
  deps: BacklinkCheckDeps = {},
): Promise<BacklinkCheckReport> {
  const at = deps.at ?? now();
  const due = await badgesDueForCheck(db, ADMIN_VIEWER, { at, limit: deps.limit });

  const report: BacklinkCheckReport = { checked: 0, verified: 0, failed: 0, revalidate: [] };

  // Sequential on purpose. Ten seconds each is slow, but firing a hundred
  // concurrent requests at a hundred third-party sites from one IP is how a
  // verification crawler gets itself blocked everywhere at once.
  for (const badge of due) {
    const result = await checkBacklink(badge.backlinkUrl, backlinkTargets(badge), {
      resolve: deps.resolve,
      fetchImpl: deps.fetchImpl,
    });

    const { changed } = await recordBacklinkCheck(db, ADMIN_VIEWER, {
      badgeId: badge.id,
      verified: result.verified,
      at,
    });
    if (changed) report.revalidate.push(...(await listingPaths(db, ADMIN_VIEWER, badge.listingId)));

    report.checked++;
    if (result.verified) report.verified++;
    else report.failed++;
  }

  return report;
}
