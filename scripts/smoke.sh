#!/usr/bin/env bash
#
# Post-deploy smoke test. Checks that the deployed site is actually serving:
#
#   /api/health   200, and its `db` field is "ok" — the container is up but
#                 the database being unreachable is exactly the failure a
#                 plain 200-on-anything check would miss. Retried first (see
#                 the warm-up below): Coolify's "finished" is a container that
#                 started, not one that is serving yet.
#   /             200, and NOT carrying an `X-Robots-Tag: noindex` header —
#                 an image built without `--build-arg SITE_ENV=production`
#                 serves that header on every route (next.config.ts) and an
#                 empty sitemap, and would otherwise fail this script three
#                 checks later with "no listing shard", which sends whoever is
#                 on call to the database instead of to the build arg.
#                 SMOKE_EXPECT_NOINDEX=1 flips it: a staging site must have it.
#   /sitemap.xml  200, and it advertises a listing shard on this site's host
#   a real listing page pulled from that shard, 200
#
# The listing page is not hand-picked: it is read out of the sitemap the
# deploy just produced, so this proves the sitemap's own claims resolve rather
# than checking four independent URLs that happen to all return 200. The
# sitemap's <loc> host is checked against $SITE_URL's host too, because a
# sitemap advertising some other host is a misconfigured NEXT_PUBLIC_SITE_URL
# and the pages would still all 200.
#
# Usage: scripts/smoke.sh https://example.co.uk
#
#   CURL                          curl binary to use (default "curl").
#                                 Overridden by scripts/smoke.test.sh to point
#                                 at test/fake-curl.sh.
#   SMOKE_WARMUP_ATTEMPTS         how many times /api/health is tried before
#                                 the result counts (default 18)
#   SMOKE_WARMUP_INTERVAL_SECONDS seconds between those tries (default 5, so
#                                 the default warm-up is up to ~90 s: the
#                                 Dockerfile HEALTHCHECK's 60 s start period
#                                 — MIGRATE_ON_BOOT may still be running —
#                                 with headroom; Traefik answers 502/503
#                                 until the container is up)
#   SMOKE_EXPECT_NOINDEX          "1" to REQUIRE the noindex header on /
#                                 (staging); unset for production
#
# jq parses /api/health's JSON. It ships on ubuntu-latest GitHub runners.
set -euo pipefail

CURL="${CURL:-curl}"
SMOKE_WARMUP_ATTEMPTS="${SMOKE_WARMUP_ATTEMPTS:-18}"
SMOKE_WARMUP_INTERVAL_SECONDS="${SMOKE_WARMUP_INTERVAL_SECONDS:-5}"
SMOKE_EXPECT_NOINDEX="${SMOKE_EXPECT_NOINDEX:-}"
SITE_URL="${1:?Usage: $0 <site-url>}"
SITE_URL="${SITE_URL%/}"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# Response headers of the most recent request land here (curl -D), so a
# check can look at a header without a second request.
HDR_FILE=$(mktemp)
trap 'rm -f "$HDR_FILE"' EXIT

# GETs $1 (a path, leading slash) against $SITE_URL. Sets $STATUS and $BODY;
# returns 1 (without exiting) if curl itself could not complete the request.
# Everything else goes through this so the request shape is in one place.
try_get() {
  local path="$1" out
  STATUS=""
  BODY=""
  : > "$HDR_FILE"
  if ! out=$("$CURL" -sS --connect-timeout 10 --max-time 30 -D "$HDR_FILE" \
    -w $'\n%{http_code}' "${SITE_URL}${path}"); then
    return 1
  fi
  STATUS="${out##*$'\n'}"
  BODY="${out%$'\n'*}"
}

# Like try_get, but fails loudly on anything but 200, including a curl-level
# failure. Prints the body.
get() {
  local path="$1"
  try_get "$path" || fail "GET ${path} — curl could not complete the request"
  [ "$STATUS" = "200" ] || fail "GET ${path} returned HTTP ${STATUS:-?}, expected 200"
  printf '%s' "$BODY"
}

# The value of response header $1 (case-insensitive) from the last request,
# or nothing.
header() {
  grep -i "^$1:" "$HDR_FILE" | head -n1 | sed -E 's/^[^:]+:[[:space:]]*//' | tr -d '\r' || true
}

# The <loc> of the first sitemap entry in an XML body, if any. `|| true`: under
# pipefail a body with no <loc> would otherwise exit the script from inside the
# $(...) before the caller's friendlier message.
first_loc() {
  grep -oE '<loc>[^<]+</loc>' | sed -E 's#<loc>(.*)</loc>#\1#' | head -n1 || true
}

# The path+query of a URL, and the host of one, lower-cased.
path_of() { sed -E 's#^https?://[^/]+##'; }
host_of() { sed -E 's#^https?://([^/]+).*#\1#' | tr 'A-Z' 'a-z'; }

site_host=$(printf '%s' "$SITE_URL" | host_of)

# Fails unless the URL in $1 is on this site's host. $2 names it for the message.
assert_own_host() {
  local url="$1" what="$2" host
  host=$(printf '%s' "$url" | host_of)
  [ "$host" = "$site_host" ] \
    || fail "$what advertises host '$host' but the site is '$site_host' — is NEXT_PUBLIC_SITE_URL set to the right URL? ($url)"
}

# --- /api/health, with warm-up ------------------------------------------------
echo "==> GET /api/health (up to ${SMOKE_WARMUP_ATTEMPTS} × ${SMOKE_WARMUP_INTERVAL_SECONDS}s until it answers 200)"
attempt=0
ready=0
while [ "$attempt" -lt "$SMOKE_WARMUP_ATTEMPTS" ]; do
  attempt=$((attempt + 1))
  if try_get /api/health && [ "$STATUS" = "200" ]; then
    ready=1
    break
  fi
  echo "    attempt ${attempt}/${SMOKE_WARMUP_ATTEMPTS}: ${STATUS:-no response}, not ready"
  [ "$attempt" -lt "$SMOKE_WARMUP_ATTEMPTS" ] && sleep "$SMOKE_WARMUP_INTERVAL_SECONDS"
done
if [ "$ready" -eq 1 ]; then
  health="$BODY"
  echo "    answered 200 on attempt ${attempt}"
else
  # One more, strict: this is what produces the real failure message.
  health=$(get /api/health)
fi
db_status=$(printf '%s' "$health" | jq -r '.db // empty')
[ "$db_status" = "ok" ] || fail "/api/health db=\"${db_status:-<missing>}\", expected \"ok\": $health"
echo "    ok (db: $db_status)"

# --- / and its indexability -------------------------------------------------
echo "==> GET /"
get / > /dev/null
robots=$(header X-Robots-Tag)
if [ "$SMOKE_EXPECT_NOINDEX" = "1" ]; then
  case "$robots" in
    *noindex*) echo "    ok (X-Robots-Tag: $robots — expected on a staging site)" ;;
    *) fail "/ has no X-Robots-Tag noindex header but SMOKE_EXPECT_NOINDEX=1 — is this really a staging build? (X-Robots-Tag: '${robots:-<absent>}')" ;;
  esac
else
  case "$robots" in
    *noindex*) fail "/ is served with X-Robots-Tag: $robots — this image was built without --build-arg SITE_ENV=production (README → SITE_ENV is a build arg). Rebuild; do not touch the database." ;;
    *) echo "    ok (indexable: X-Robots-Tag ${robots:-absent})" ;;
  esac
fi

# --- sitemap and a real listing page ------------------------------------------
echo "==> GET /sitemap.xml"
sitemap_index=$(get /sitemap.xml)
listing_shard_url=$(printf '%s' "$sitemap_index" | grep -oE '<loc>[^<]+</loc>' \
  | sed -E 's#<loc>(.*)</loc>#\1#' | grep '/sitemaps/sitemap/listings-' | head -n1 || true)
[ -n "$listing_shard_url" ] \
  || fail "/sitemap.xml has no listing shard to check a real listing page against: $sitemap_index"
assert_own_host "$listing_shard_url" "/sitemap.xml"
echo "    ok (listing shard: $listing_shard_url)"

shard_path=$(printf '%s' "$listing_shard_url" | path_of)
echo "==> GET $shard_path"
shard_body=$(get "$shard_path")
listing_url=$(printf '%s' "$shard_body" | first_loc)
[ -n "$listing_url" ] || fail "listing shard $shard_path has no <loc> entries"
assert_own_host "$listing_url" "$shard_path"

listing_path=$(printf '%s' "$listing_url" | path_of)
echo "==> GET $listing_path (a real listing page)"
get "$listing_path" > /dev/null
echo "    ok"

echo "PASS: /api/health (db: ok), / (indexability as expected), /sitemap.xml, and a real listing page all returned 200."
