#!/usr/bin/env bash
#
# Post-deploy smoke test. Checks that the deployed site is actually serving:
#
#   /api/health   200, and its `db` field is "ok" — the container is up but
#                 the database being unreachable is exactly the failure a
#                 plain 200-on-anything check would miss.
#   /             200
#   /sitemap.xml  200, and it advertises a listing shard
#   a real listing page pulled from that shard, 200
#
# The listing page is not hand-picked: it is read out of the sitemap the
# deploy just produced, so this proves the sitemap's own claims resolve rather
# than checking four independent URLs that happen to all return 200.
#
# Usage: scripts/smoke.sh https://example.co.uk
#
#   CURL   curl binary to use (default "curl"). Overridden by
#          scripts/smoke.test.sh to point at test/fake-curl.sh.
#
# jq parses /api/health's JSON. It ships on ubuntu-latest GitHub runners.
set -euo pipefail

CURL="${CURL:-curl}"
SITE_URL="${1:?Usage: $0 <site-url>}"
SITE_URL="${SITE_URL%/}"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# GETs $1 (a path, leading slash) against $SITE_URL. Prints the body; fails
# loudly on anything but 200, including a curl-level failure.
get() {
  local path="$1" out status body
  if ! out=$("$CURL" -sS --connect-timeout 10 --max-time 30 -w $'\n%{http_code}' "${SITE_URL}${path}"); then
    fail "GET ${path} — curl could not complete the request"
  fi
  status="${out##*$'\n'}"
  body="${out%$'\n'*}"
  [ "$status" = "200" ] || fail "GET ${path} returned HTTP ${status:-?}, expected 200"
  printf '%s' "$body"
}

# The <loc> of the first sitemap entry in an XML body, if any.
first_loc() {
  grep -oE '<loc>[^<]+</loc>' | sed -E 's#<loc>(.*)</loc>#\1#' | head -n1
}

# The path+query of a URL this same site emitted, independent of whatever
# exact scheme/host string $SITE_URL was passed as.
path_of() {
  sed -E 's#^https?://[^/]+##'
}

echo "==> GET /api/health"
health=$(get /api/health)
db_status=$(printf '%s' "$health" | jq -r '.db // empty')
[ "$db_status" = "ok" ] || fail "/api/health db=\"${db_status:-<missing>}\", expected \"ok\": $health"
echo "    ok (db: $db_status)"

echo "==> GET /"
get / > /dev/null
echo "    ok"

echo "==> GET /sitemap.xml"
sitemap_index=$(get /sitemap.xml)
listing_shard_url=$(printf '%s' "$sitemap_index" | grep -oE '<loc>[^<]+</loc>' \
  | sed -E 's#<loc>(.*)</loc>#\1#' | grep '/sitemaps/sitemap/listings-' | head -n1 || true)
[ -n "$listing_shard_url" ] \
  || fail "/sitemap.xml has no listing shard to check a real listing page against: $sitemap_index"
echo "    ok (listing shard: $listing_shard_url)"

shard_path=$(printf '%s' "$listing_shard_url" | path_of)
echo "==> GET $shard_path"
shard_body=$(get "$shard_path")
listing_url=$(printf '%s' "$shard_body" | first_loc)
[ -n "$listing_url" ] || fail "listing shard $shard_path has no <loc> entries"

listing_path=$(printf '%s' "$listing_url" | path_of)
echo "==> GET $listing_path (a real listing page)"
get "$listing_path" > /dev/null
echo "    ok"

echo "PASS: /api/health (db: ok), /, /sitemap.xml, and a real listing page all returned 200."
