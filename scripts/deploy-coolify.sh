#!/usr/bin/env bash
#
# Triggers a Coolify deployment for one or more applications and polls each
# until it reaches a terminal state, failing (non-zero exit) if any of them
# fails or times out. Used by .github/workflows/deploy.yml for the web and
# worker apps; nothing here is Coolify-specific enough to need two copies.
#
# Coolify API (documented in the task brief, not discoverable from code):
#
#   POST {COOLIFY_BASE}/api/v1/deploy?uuid=<uuid>&force=true
#     -> {"deployments":[{"deployment_uuid":"..."}]}
#   GET  {COOLIFY_BASE}/api/v1/deployments/<deployment_uuid>
#     -> {"status":"queued"|"in_progress"|"finished"|"failed"|"cancelled-by-user"}
#
# Both take `Authorization: Bearer <token>`.
#
# `force=true` is Coolify's "rebuild without cache", not "force a deploy": it
# costs a full cold Next.js build per app every time. It matches the
# redeploy.sh already in use for the other sites, and a cache miss is the
# price of never shipping a stale layer.
#
# Usage:
#
#   COOLIFY_BASE=https://coolify.example.com COOLIFY_TOKEN=xxx \
#     scripts/deploy-coolify.sh web:$COOLIFY_WEB_UUID worker:$COOLIFY_WORKER_UUID
#
# Each argument is `<label>:<uuid>`. The label is only for readable log
# output — Coolify never sees it. Arguments deploy IN ORDER, one at a time:
# each is triggered and polled to a terminal status before the next is
# triggered, and the first failure or timeout stops the script (non-zero exit)
# without touching the apps after it.
#
# Put the app that migrates first. Schema migrations run at web boot
# (docker-entrypoint.sh, MIGRATE_ON_BOOT=true, web role only); a worker
# container built from the same commit and started concurrently would come
# up — and start draining job_queue — before the web container had applied
# the migration the new worker code expects. Sequential also means a worker
# is never rolled onto a web deploy that failed.
#
#   CURL                    curl binary to use (default "curl"). Overridden by
#                           tests to point at test/fake-curl.sh — no network
#                           involved in scripts/deploy-coolify.test.sh.
#   POLL_INTERVAL_SECONDS   seconds between polls (default 5)
#   POLL_TIMEOUT_SECONDS    per-deployment timeout before giving up (default
#                           600). The clock starts when that app is triggered,
#                           so it is per app, not for the whole run.
#
# jq parses the JSON. It ships on ubuntu-latest GitHub runners and is not worth
# vendoring a Node fallback for here.
set -euo pipefail

CURL="${CURL:-curl}"
POLL_INTERVAL_SECONDS="${POLL_INTERVAL_SECONDS:-5}"
POLL_TIMEOUT_SECONDS="${POLL_TIMEOUT_SECONDS:-600}"

if [ "$#" -eq 0 ]; then
  echo "Usage: $0 <label>:<uuid> [<label>:<uuid> ...]" >&2
  exit 2
fi

: "${COOLIFY_BASE:?COOLIFY_BASE is not set}"
: "${COOLIFY_TOKEN:?COOLIFY_TOKEN is not set}"

BASE="${COOLIFY_BASE%/}"

# One request, everywhere. `-w $'\n%{http_code}'` puts the status on its own
# trailing line so a non-2xx and an unparseable body are both caught here,
# rather than surfacing three lines later as a confusing jq error. A non-zero
# exit from curl itself (DNS, connection refused, timeout) is a different
# failure — reported separately, not folded into the same message.
request() {
  local method="$1" url="$2"
  local out status body
  if ! out=$("$CURL" -sS -X "$method" \
    --connect-timeout 10 --max-time 30 \
    -H "Authorization: Bearer $COOLIFY_TOKEN" \
    -H "Accept: application/json" \
    -w $'\n%{http_code}' \
    "$url"); then
    echo "Coolify API $method $url -> curl could not complete the request" >&2
    return 1
  fi
  status="${out##*$'\n'}"
  body="${out%$'\n'*}"
  if ! [[ "$status" =~ ^[0-9]+$ ]] || [ "$status" -lt 200 ] || [ "$status" -ge 300 ]; then
    echo "Coolify API $method $url -> HTTP ${status:-?}: $body" >&2
    return 1
  fi
  printf '%s' "$body"
}

trigger() {
  local uuid="$1"
  local body dep_uuid
  body=$(request POST "$BASE/api/v1/deploy?uuid=${uuid}&force=true") || return 1
  dep_uuid=$(printf '%s' "$body" | jq -r '.deployments[0].deployment_uuid // empty')
  if [ -z "$dep_uuid" ]; then
    echo "Coolify deploy trigger for $uuid returned no deployment_uuid: $body" >&2
    return 1
  fi
  printf '%s' "$dep_uuid"
}

poll() {
  local label="$1" dep_uuid="$2"
  local elapsed=0 body status
  while true; do
    body=$(request GET "$BASE/api/v1/deployments/${dep_uuid}") || return 1
    status=$(printf '%s' "$body" | jq -r '.status // empty')
    case "$status" in
      finished)
        echo "==> $label: finished"
        return 0
        ;;
      failed)
        echo "==> $label: failed" >&2
        return 1
        ;;
      cancelled-by-user)
        echo "==> $label: cancelled in Coolify's UI while this run was waiting on it" >&2
        return 1
        ;;
      queued | in_progress)
        echo "==> $label: $status (${elapsed}s elapsed)"
        ;;
      *)
        echo "==> $label: unexpected status '${status:-<empty>}': $body" >&2
        return 1
        ;;
    esac
    if [ "$elapsed" -ge "$POLL_TIMEOUT_SECONDS" ]; then
      echo "==> $label: timed out after ${POLL_TIMEOUT_SECONDS}s waiting for a terminal status" >&2
      return 1
    fi
    sleep "$POLL_INTERVAL_SECONDS"
    elapsed=$((elapsed + POLL_INTERVAL_SECONDS))
  done
}

declare -a LABELS=()
declare -a UUIDS=()

for arg in "$@"; do
  label="${arg%%:*}"
  uuid="${arg#*:}"
  if [ -z "$label" ] || [ -z "$uuid" ] || [ "$label" = "$arg" ]; then
    echo "Bad argument '$arg' — expected <label>:<uuid>" >&2
    exit 2
  fi
  LABELS+=("$label")
  UUIDS+=("$uuid")
done

# Called on the first failure: names what was NOT deployed because of it, then
# exits non-zero. $1 = failed label, $2 = index of the failed app.
abort() {
  local label="$1" i="$2"
  local rest="${LABELS[*]:$((i + 1))}"
  if [ -n "$rest" ]; then
    echo "Deployment of $label failed; not deploying $rest." >&2
  else
    echo "Deployment of $label failed." >&2
  fi
  exit 1
}

echo "==> deploying ${#UUIDS[@]} application(s) in order: ${LABELS[*]}"
for i in "${!UUIDS[@]}"; do
  label="${LABELS[$i]}"
  if ! dep_uuid=$(trigger "${UUIDS[$i]}"); then
    echo "==> $label: failed to trigger" >&2
    abort "$label" "$i"
  fi
  echo "==> $label: deployment $dep_uuid triggered"
  poll "$label" "$dep_uuid" || abort "$label" "$i"
done

echo "All deployments finished."
