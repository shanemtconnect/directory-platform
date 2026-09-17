#!/usr/bin/env bash
#
# Dry-run tests for scripts/smoke.sh against test/fake-curl.sh — no network,
# no real deployment. Exercises the happy path (four real 200s, the listing
# page pulled out of the sitemap the "site" actually served), the warm-up
# (a container that answers 503 and then 200), the indexability check in both
# modes, and the ways a broken deploy should fail the check: db down, a plain
# 5xx, a missing route, a sitemap with no listing shard or on the wrong host,
# and a network error.
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

# Runs smoke.sh with a fresh fake-curl state dir and request log, no sleeping
# between warm-up attempts, and only two attempts unless a case says
# otherwise — so a failing /api/health is fast. HEALTH_CALLS counts how many
# times /api/health was requested.
run() {
  STATE_DIR=$(mktemp -d)
  LOG=$(mktemp)
  set +e
  OUT=$(env CURL="$FAKE_CURL" \
    FAKE_CURL_STATE_DIR="$STATE_DIR" \
    FAKE_CURL_LOG="$LOG" \
    SMOKE_WARMUP_INTERVAL_SECONDS=0 \
    SMOKE_WARMUP_ATTEMPTS=2 \
    "${HAPPY_ROUTES[@]}" "$@" "$SCRIPT" "$SITE" 2>&1)
  CODE=$?
  set -e
  LOG_CONTENT=$(cat "$LOG")
  HEALTH_CALLS=$(grep -c "GET .*/api/health" <<<"$LOG_CONTENT" || true)
  rm -rf "$STATE_DIR" "$LOG"
}

# --- 1: happy path -----------------------------------------------------------
run
[ "$CODE" -eq 0 ] || fail "case 1: expected exit 0, got $CODE: $OUT"
grep -q "^PASS:" <<<"$OUT" || fail "case 1: no PASS line: $OUT"
grep -q "manchester/some-listing" <<<"$OUT" || fail "case 1: did not check the listing page pulled from the sitemap: $OUT"
[ "$HEALTH_CALLS" -eq 1 ] || fail "case 1: a healthy site should need exactly one /api/health request, got $HEALTH_CALLS: $LOG_CONTENT"
[ "$CODE" -eq 0 ] && [ "$HEALTH_CALLS" -eq 1 ] && pass "case 1: a healthy site passes, using a listing page read out of its own sitemap"

# --- 2: db not ok -------------------------------------------------------------
run FAKE_CURL_ROUTE_api_health='200:{"ok":false,"db":"down","redis":"ok"}'
[ "$CODE" -ne 0 ] || fail "case 2: expected non-zero exit when db is down, got 0: $OUT"
grep -qi 'db="down"' <<<"$OUT" || fail "case 2: no clear message about db status: $OUT"
[ "$CODE" -ne 0 ] && pass "case 2: /api/health reporting db != ok fails the check even though the route itself is 200"

# --- 3: health check itself is 503 -------------------------------------------
run FAKE_CURL_ROUTE_api_health='503:{"ok":false,"db":"down"}'
[ "$CODE" -ne 0 ] || fail "case 3: expected non-zero exit on a 503, got 0: $OUT"
grep -q "HTTP 503" <<<"$OUT" || fail "case 3: no HTTP 503 reported: $OUT"
# 2 warm-up attempts, then the one strict request that produces the message.
[ "$HEALTH_CALLS" -eq 3 ] || fail "case 3: expected 3 /api/health requests (2 warm-up + 1 strict), got $HEALTH_CALLS: $LOG_CONTENT"
[ "$CODE" -ne 0 ] && [ "$HEALTH_CALLS" -eq 3 ] && pass "case 3: a /api/health that never answers 200 fails the check after the warm-up gives up"

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

# --- 8: warm-up — 503, 503, then 200 -------------------------------------------
run SMOKE_WARMUP_ATTEMPTS=5 \
  'FAKE_CURL_ROUTE_SEQ_api_health=503:{"ok":false}|503:{"ok":false}|200:{"ok":true,"db":"ok","redis":"ok"}'
[ "$CODE" -eq 0 ] || fail "case 8: expected exit 0 once /api/health comes up, got $CODE: $OUT"
grep -q "answered 200 on attempt 3" <<<"$OUT" || fail "case 8: should report the attempt it came up on: $OUT"
[ "$HEALTH_CALLS" -eq 3 ] || fail "case 8: expected 3 /api/health requests, got $HEALTH_CALLS: $LOG_CONTENT"
[ "$CODE" -eq 0 ] && [ "$HEALTH_CALLS" -eq 3 ] && pass "case 8: a container still starting (503, 503, 200) passes once it answers, without a second strict request"

# --- 9: warm-up — connection refused, then 200 ----------------------------------
# A curl-level failure during warm-up is "not ready yet", not a hard failure:
# fake-curl cannot fail-then-succeed per path, so this plays it as a 502 from
# the proxy (what Traefik returns before the container is up) followed by 200.
run SMOKE_WARMUP_ATTEMPTS=5 \
  'FAKE_CURL_ROUTE_SEQ_api_health=502:Bad Gateway|200:{"ok":true,"db":"ok","redis":"ok"}'
[ "$CODE" -eq 0 ] || fail "case 9: expected exit 0 after a 502 then 200, got $CODE: $OUT"
[ "$HEALTH_CALLS" -eq 2 ] || fail "case 9: expected 2 /api/health requests, got $HEALTH_CALLS: $LOG_CONTENT"
[ "$CODE" -eq 0 ] && [ "$HEALTH_CALLS" -eq 2 ] && pass "case 9: a proxy 502 before the container is up is retried, not failed"

# --- 10: production serving noindex ------------------------------------------
run 'FAKE_CURL_HEADERS_=X-Robots-Tag: noindex, nofollow, noarchive'
[ "$CODE" -ne 0 ] || fail "case 10: expected non-zero exit when / is noindex, got 0: $OUT"
grep -q "SITE_ENV=production" <<<"$OUT" || fail "case 10: the message should name the build arg: $OUT"
[ "$CODE" -ne 0 ] && pass "case 10: an X-Robots-Tag noindex on / fails the check and names --build-arg SITE_ENV=production"

# --- 11: staging — noindex required and present -------------------------------
run SMOKE_EXPECT_NOINDEX=1 'FAKE_CURL_HEADERS_=X-Robots-Tag: noindex, nofollow, noarchive'
[ "$CODE" -eq 0 ] || fail "case 11: expected exit 0 on a staging site with noindex, got $CODE: $OUT"
[ "$CODE" -eq 0 ] && pass "case 11: SMOKE_EXPECT_NOINDEX=1 accepts a noindex /"

# --- 12: staging — noindex required and absent --------------------------------
run SMOKE_EXPECT_NOINDEX=1
[ "$CODE" -ne 0 ] || fail "case 12: expected non-zero exit when staging is missing noindex, got 0: $OUT"
grep -q "SMOKE_EXPECT_NOINDEX=1" <<<"$OUT" || fail "case 12: the message should say what was expected: $OUT"
[ "$CODE" -ne 0 ] && pass "case 12: SMOKE_EXPECT_NOINDEX=1 fails an indexable / (a production build where staging was expected)"

# --- 13: sitemap advertises another host ---------------------------------------
run "FAKE_CURL_ROUTE_sitemap_xml=200:<sitemapindex><sitemap><loc>https://wrong-host.example/sitemaps/sitemap/listings-0.xml</loc></sitemap></sitemapindex>"
[ "$CODE" -ne 0 ] || fail "case 13: expected non-zero exit when the sitemap's host is wrong, got 0: $OUT"
grep -q "wrong-host.example" <<<"$OUT" || fail "case 13: the message should name the wrong host: $OUT"
grep -q "NEXT_PUBLIC_SITE_URL" <<<"$OUT" || fail "case 13: the message should point at NEXT_PUBLIC_SITE_URL: $OUT"
[ "$CODE" -ne 0 ] && pass "case 13: a sitemap advertising a different host fails the check instead of passing on path alone"

# --- 14: listing shard has no <loc> at all -------------------------------------
run "FAKE_CURL_ROUTE_sitemaps_sitemap_listings_0_xml=200:<urlset></urlset>"
[ "$CODE" -ne 0 ] || fail "case 14: expected non-zero exit on an empty shard, got 0: $OUT"
grep -q "has no <loc> entries" <<<"$OUT" || fail "case 14: expected the friendly empty-shard message, not a silent pipefail exit: $OUT"
[ "$CODE" -ne 0 ] && pass "case 14: an empty listing shard fails with its own message rather than a silent pipefail exit"

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
