#!/usr/bin/env bash
#
# Dry-run tests for scripts/deploy-coolify.sh against test/fake-curl.sh — no
# network, no real Coolify instance, ever. Exercises the polling loop (several
# statuses before a terminal one), both terminal outcomes, a timeout, an HTTP
# error from Coolify, a curl-level network failure, and the argument-parsing
# guards.
#
#   ./scripts/deploy-coolify.test.sh
set -euo pipefail
cd "$(dirname "$0")/.."

FAKE_CURL="$PWD/test/fake-curl.sh"
SCRIPT="$PWD/scripts/deploy-coolify.sh"

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

# Runs deploy-coolify.sh with a fresh state dir and log file, in an env that
# already has COOLIFY_BASE/COOLIFY_TOKEN/CURL/polling speed set — case
# functions add whatever FAKE_CURL_* they need on top and inspect
# $OUT/$CODE/$LOG afterwards.
run() {
  STATE_DIR=$(mktemp -d)
  LOG=$(mktemp)
  set +e
  OUT=$(env \
    COOLIFY_BASE=https://coolify.example \
    COOLIFY_TOKEN=test-token \
    CURL="$FAKE_CURL" \
    POLL_INTERVAL_SECONDS=0 \
    POLL_TIMEOUT_SECONDS="${POLL_TIMEOUT_SECONDS:-5}" \
    FAKE_CURL_STATE_DIR="$STATE_DIR" \
    FAKE_CURL_LOG="$LOG" \
    "$@" \
    "$SCRIPT" "${ARGS[@]}" 2>&1)
  CODE=$?
  set -e
  LOG_CONTENT=$(cat "$LOG")
  rm -rf "$STATE_DIR" "$LOG"
}

# --- 1: single app, several statuses before finished -----------------------
ARGS=(web:web-uuid)
run FAKE_CURL_SEQ_dep_web_uuid=queued,queued,in_progress,finished
[ "$CODE" -eq 0 ] || fail "case 1: expected exit 0, got $CODE: $OUT"
grep -q "web: finished" <<<"$OUT" || fail "case 1: no 'finished' line: $OUT"
poll_calls=$(grep -c "GET .*deployments/dep-web-uuid" <<<"$LOG_CONTENT" || true)
[ "$poll_calls" -eq 4 ] || fail "case 1: expected 4 polls (one per status), got $poll_calls: $LOG_CONTENT"
[ "$CODE" -eq 0 ] && [ "$poll_calls" -eq 4 ] && pass "case 1: polls through queued/queued/in_progress before finished"

# --- 2: two apps, one finishes, one fails — both reported, exit non-zero ---
ARGS=(web:web-uuid worker:worker-uuid)
run FAKE_CURL_SEQ_dep_web_uuid=finished FAKE_CURL_SEQ_dep_worker_uuid=in_progress,failed
[ "$CODE" -ne 0 ] || fail "case 2: expected non-zero exit, got 0: $OUT"
grep -q "web: finished" <<<"$OUT" || fail "case 2: web should still be reported finished: $OUT"
grep -q "worker: failed" <<<"$OUT" || fail "case 2: worker should be reported failed: $OUT"
[ "$CODE" -ne 0 ] && pass "case 2: a failed app fails the run without hiding the other app's result"

# --- 3: never reaches a terminal status — times out ------------------------
ARGS=(web:web-uuid)
POLL_TIMEOUT_SECONDS=0 run FAKE_CURL_SEQ_dep_web_uuid=queued,queued,queued
[ "$CODE" -ne 0 ] || fail "case 3: expected non-zero exit on timeout, got 0: $OUT"
grep -q "timed out" <<<"$OUT" || fail "case 3: no timeout message: $OUT"
[ "$CODE" -ne 0 ] && pass "case 3: a deployment stuck in queued/in_progress times out instead of hanging"

# --- 4: Coolify rejects the trigger (401) -----------------------------------
ARGS=(web:web-uuid)
run FAKE_CURL_TRIGGER_HTTP=401
[ "$CODE" -ne 0 ] || fail "case 4: expected non-zero exit on a 401, got 0: $OUT"
grep -q "HTTP 401" <<<"$OUT" || fail "case 4: no HTTP 401 reported: $OUT"
[ "$CODE" -ne 0 ] && pass "case 4: an HTTP error on the trigger fails the run and says why"

# --- 5: curl itself cannot reach Coolify (network error) -------------------
ARGS=(web:web-uuid)
run FAKE_CURL_FAIL_web_uuid=1
[ "$CODE" -ne 0 ] || fail "case 5: expected non-zero exit on a curl failure, got 0: $OUT"
grep -qi "could not complete the request" <<<"$OUT" || fail "case 5: no network-failure message: $OUT"
[ "$CODE" -ne 0 ] && pass "case 5: a curl-level failure is distinguished from an HTTP error"

# --- 6: bad argument shape --------------------------------------------------
set +e
OUT=$(COOLIFY_BASE=https://coolify.example COOLIFY_TOKEN=t "$SCRIPT" not-a-pair 2>&1)
CODE=$?
set -e
[ "$CODE" -eq 2 ] || fail "case 6: expected exit 2 on a bad argument, got $CODE: $OUT"
grep -q "expected <label>:<uuid>" <<<"$OUT" || fail "case 6: no usage message: $OUT"
[ "$CODE" -eq 2 ] && pass "case 6: an argument with no ':' is rejected before any request is made"

# --- 7: missing required env ------------------------------------------------
set +e
OUT=$(unset COOLIFY_BASE COOLIFY_TOKEN; "$SCRIPT" web:uuid 2>&1)
CODE=$?
set -e
[ "$CODE" -ne 0 ] || fail "case 7: expected non-zero exit with no COOLIFY_BASE, got 0: $OUT"
grep -q "COOLIFY_BASE is not set" <<<"$OUT" || fail "case 7: no clear message about the missing var: $OUT"
[ "$CODE" -ne 0 ] && pass "case 7: a missing COOLIFY_BASE/COOLIFY_TOKEN fails before any request"

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
