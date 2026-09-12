#!/usr/bin/env bash
#
# Dry-run tests for scripts/smoke.sh against test/fake-curl.sh — no network,
# no real deployment. Exercises the happy path (four real 200s, the listing
# page pulled out of the sitemap the "site" actually served) and the ways a
# broken deploy should fail the check: db down, a plain 5xx, a missing route,
# a sitemap with no listing shard, and a network error.
#
#   ./scripts/smoke.test.sh
set -euo pipefail
cd "$(dirname "$0")/.."

FAKE_CURL="$PWD/test/fake-curl.sh"
SCRIPT="$PWD/scripts/smoke.sh"
SITE="https://example.co.uk"

PASS=0
FAIL=0

fail() {
  echo "FAIL: $*" >&2
  FAIL=$((FAIL + 1))
}

pass() {
  echo "ok: $*"
  PASS=$((PASS + 1))
}

# A well-formed site: health ok, home page, a sitemap index with one listing
# shard, that shard with one listing, and the listing page itself. Case
# functions override individual FAKE_CURL_ROUTE_* vars on top of this to break
# one thing at a time.
HAPPY_ROUTES=(
  FAKE_CURL_ROUTE_api_health='200:{"ok":true,"db":"ok","redis":"ok"}'
  FAKE_CURL_ROUTE_='200:<html>home</html>'
  "FAKE_CURL_ROUTE_sitemap_xml=200:<sitemapindex><sitemap><loc>${SITE}/sitemaps/sitemap/static+cities.xml</loc></sitemap><sitemap><loc>${SITE}/sitemaps/sitemap/listings-0.xml</loc></sitemap></sitemapindex>"
  "FAKE_CURL_ROUTE_sitemaps_sitemap_listings_0_xml=200:<urlset><url><loc>${SITE}/manchester/some-listing</loc></url></urlset>"
  FAKE_CURL_ROUTE_manchester_some_listing='200:<html>listing</html>'
)

run() {
  set +e
  OUT=$(env CURL="$FAKE_CURL" "${HAPPY_ROUTES[@]}" "$@" "$SCRIPT" "$SITE" 2>&1)
  CODE=$?
  set -e
}

# --- 1: happy path -----------------------------------------------------------
run
[ "$CODE" -eq 0 ] || fail "case 1: expected exit 0, got $CODE: $OUT"
grep -q "^PASS:" <<<"$OUT" || fail "case 1: no PASS line: $OUT"
grep -q "manchester/some-listing" <<<"$OUT" || fail "case 1: did not check the listing page pulled from the sitemap: $OUT"
[ "$CODE" -eq 0 ] && pass "case 1: a healthy site passes, using a listing page read out of its own sitemap"

# --- 2: db not ok -------------------------------------------------------------
run FAKE_CURL_ROUTE_api_health='200:{"ok":false,"db":"down","redis":"ok"}'
[ "$CODE" -ne 0 ] || fail "case 2: expected non-zero exit when db is down, got 0: $OUT"
grep -qi 'db="down"' <<<"$OUT" || fail "case 2: no clear message about db status: $OUT"
[ "$CODE" -ne 0 ] && pass "case 2: /api/health reporting db != ok fails the check even though the route itself is 200"

# --- 3: health check itself is 503 -------------------------------------------
run FAKE_CURL_ROUTE_api_health='503:{"ok":false,"db":"down"}'
[ "$CODE" -ne 0 ] || fail "case 3: expected non-zero exit on a 503, got 0: $OUT"
grep -q "HTTP 503" <<<"$OUT" || fail "case 3: no HTTP 503 reported: $OUT"
[ "$CODE" -ne 0 ] && pass "case 3: a non-200 /api/health fails the check"

# --- 4: home page missing ----------------------------------------------------
run FAKE_CURL_ROUTE_=''
[ "$CODE" -ne 0 ] || fail "case 4: expected non-zero exit when / 404s, got 0: $OUT"
grep -q "GET / returned HTTP 404" <<<"$OUT" || fail "case 4: no message about /: $OUT"
[ "$CODE" -ne 0 ] && pass "case 4: a 404 on / fails the check"

# --- 5: sitemap has no listing shard -----------------------------------------
run "FAKE_CURL_ROUTE_sitemap_xml=200:<sitemapindex><sitemap><loc>${SITE}/sitemaps/sitemap/static+cities.xml</loc></sitemap></sitemapindex>"
[ "$CODE" -ne 0 ] || fail "case 5: expected non-zero exit with no listing shard, got 0: $OUT"
grep -qi "no listing shard" <<<"$OUT" || fail "case 5: no message about the missing listing shard: $OUT"
[ "$CODE" -ne 0 ] && pass "case 5: a sitemap advertising no listing shard fails the check rather than skipping the listing page"

# --- 6: network failure -------------------------------------------------------
run FAKE_CURL_FAIL_api_health=1
[ "$CODE" -ne 0 ] || fail "case 6: expected non-zero exit on a curl failure, got 0: $OUT"
grep -qi "could not complete the request" <<<"$OUT" || fail "case 6: no network-failure message: $OUT"
[ "$CODE" -ne 0 ] && pass "case 6: a curl-level failure fails the check with a distinct message"

# --- 7: no site URL argument --------------------------------------------------
set +e
OUT=$(CURL="$FAKE_CURL" "$SCRIPT" 2>&1)
CODE=$?
set -e
[ "$CODE" -ne 0 ] || fail "case 7: expected non-zero exit with no argument, got 0: $OUT"
grep -q "Usage:" <<<"$OUT" || fail "case 7: no usage message: $OUT"
[ "$CODE" -ne 0 ] && pass "case 7: no site URL fails before any request"

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
