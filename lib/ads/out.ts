/**
 * The outbound side of a sponsor card: what a target URL may be, and what
 * `/out/<id>` strips before it sends somebody there.
 *
 * Pure. No Redis, no database, no `next/*`, so the route handler, the
 * self-serve form and the tests all share one definition of "safe".
 */

/** How long a target URL may be — a landing page, not a payload. */
export const MAX_TARGET_URL_LENGTH = 2048;

/**
 * Click-tracking parameters that are never ours to forward. `utm_*` is kept:
 * an advertiser sets those on purpose to see this site in their analytics,
 * and stripping them would make the rail look like it sends no traffic.
 * Everything here is a per-visitor click id that some other platform minted
 * and that would follow the reader to the advertiser's site.
 */
export const STRIPPED_TRACKING_PARAMS: readonly string[] = [
  "fbclid", "gclid", "gclsrc", "dclid", "gbraid", "wbraid", "msclkid", "yclid",
  "twclid", "ttclid", "li_fat_id", "igshid", "mc_cid", "mc_eid", "_hsenc", "_hsmi",
  "hsa_acc", "hsa_cam", "hsa_grp", "hsa_ad", "hsa_src", "hsa_tgt", "hsa_kw", "hsa_mt",
  "hsa_net", "hsa_ver", "vero_id", "vero_conv", "wickedid", "_openstat", "ref_src",
  "ref_url", "s_kwcid", "srsltid", "epik", "_branch_match_id", "_bta_tid", "_bta_c",
];

const STRIPPED_PREFIXES: readonly string[] = ["oly_", "pk_", "piwik_", "matomo_", "mtm_"];

function isStrippedParam(name: string): boolean {
  const lower = name.toLowerCase();
  if (STRIPPED_TRACKING_PARAMS.includes(lower)) return true;
  return STRIPPED_PREFIXES.some((p) => lower.startsWith(p));
}

/**
 * True when a URL is one the rail may send a reader to: absolute, http(s),
 * carries no credentials, and is not absurdly long. Anything else — a
 * `javascript:` URL, a relative path that would resolve on this site, a
 * `user:pass@host` — is refused at the form, not cleaned up later.
 */
export function isSafeTargetUrl(value: string): boolean {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_TARGET_URL_LENGTH) {
    return false;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  if (url.username !== "" || url.password !== "") return false;
  if (url.hostname === "" || url.hostname === "localhost") return false;
  return true;
}

/**
 * The URL `/out/<id>` redirects to: the stored target with the click-tracking
 * parameters above removed and everything else — path, `utm_*`, fragment —
 * exactly as the advertiser wrote it. Returns null for a URL that is not
 * safe, so a row somebody edited by hand cannot turn the redirect into an
 * open one.
 */
export function cleanTargetUrl(value: string): string | null {
  if (!isSafeTargetUrl(value)) return null;
  const url = new URL(value);
  const keep = new URLSearchParams();
  let stripped = false;
  for (const [name, v] of url.searchParams) {
    if (isStrippedParam(name)) {
      stripped = true;
      continue;
    }
    keep.append(name, v);
  }
  if (!stripped) return url.toString();
  const query = keep.toString();
  url.search = query === "" ? "" : `?${query}`;
  return url.toString();
}
