#!/usr/bin/env bash
#
# A stand-in for curl, driven entirely by env vars, used by
# scripts/deploy-coolify.test.sh (via CURL=./test/fake-curl.sh) and
# scripts/smoke.test.sh so both scripts' network calls can be exercised with
# no network involved.
#
# It understands exactly the requests those two scripts make: a GET or POST to
# a URL, `-w $'\n%{http_code}'` appended, and replies with a body plus a
# trailing "\n<code>" line — the same shape real curl's -w gives them. (It does
# not actually parse the -w template; every caller here uses the same one, and
# faithfully reimplementing curl's templating would test the fake, not the
# scripts.)
#
# Recognises three URL shapes:
#   POST .../api/v1/deploy?uuid=<uuid>&force=true   (Coolify trigger)
#   GET  .../api/v1/deployments/<dep_uuid>          (Coolify poll)
#   GET  <anything else>                            (smoke.sh's own requests —
#                                                     see FAKE_CURL_ROUTE_* below)
#
# Env vars:
#
#   FAKE_CURL_LOG                 append "<method> <url>" here, one per call —
#                                  lets a test assert what was actually requested.
#
#   FAKE_CURL_TRIGGER_HTTP        HTTP status for the trigger POST (default 200)
#   FAKE_CURL_TRIGGER_UUID_<K>    deployment_uuid returned for trigger uuid <K>
#                                  (sanitized: non-alnum -> "_"); default "dep-<uuid>"
#
#   FAKE_CURL_STATE_DIR           required for any poll: one counter file per
#                                  deployment_uuid, so repeated calls step
#                                  through FAKE_CURL_SEQ_<K> instead of always
#                                  returning its first entry. The test creates
#                                  and removes this directory.
#   FAKE_CURL_SEQ_<K>             comma-separated statuses returned in order for
#                                  poll of deployment_uuid <K> (sanitized);
#                                  holds at the last entry once exhausted.
#                                  Default "finished".
#   FAKE_CURL_POLL_HTTP_<K>       HTTP status for polls of <K> (default 200)
#
#   FAKE_CURL_ROUTE_<K>=<code>:<body>
#                                  for smoke.sh: <K> is the request path
#                                  (leading slash stripped, non-alnum -> "_"),
#                                  <code> is the HTTP status, <body> is
#                                  everything after the first ":". A path with
#                                  no matching var 404s.
#   FAKE_CURL_FAIL_<K>=1          make the call for path/uuid <K> fail the way a
#                                  real network error would: curl itself exits
#                                  non-zero and prints nothing.
set -euo pipefail

sanitize() { printf '%s' "$1" | tr -c 'A-Za-z0-9' '_'; }

method="GET"
url=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "-X" ]; then
    method="$arg"
  fi
  prev="$arg"
  # curl's URL is always the last argument in every call these scripts make.
  url="$arg"
done

if [ -n "${FAKE_CURL_LOG:-}" ]; then
  echo "$method $url" >> "$FAKE_CURL_LOG"
fi

emit() {
  # $1 = body, $2 = http status — the same "<body>\n<code>" shape curl's
  # `-w $'\n%{http_code}'` produces.
  printf '%s\n%s' "$1" "$2"
}

if [[ "$url" == *"/api/v1/deploy?"* ]]; then
  uuid=$(printf '%s' "$url" | sed -E 's/.*uuid=([^&]*).*/\1/')
  key=$(sanitize "$uuid")

  failvar="FAKE_CURL_FAIL_${key}"
  if [ "${!failvar:-0}" = "1" ]; then
    echo "fake-curl: simulated network failure triggering $uuid" >&2
    exit 7
  fi

  uuidvar="FAKE_CURL_TRIGGER_UUID_${key}"
  dep_uuid="${!uuidvar:-dep-${uuid}}"
  code="${FAKE_CURL_TRIGGER_HTTP:-200}"
  if [ "$code" -ge 200 ] && [ "$code" -lt 300 ]; then
    emit "{\"deployments\":[{\"deployment_uuid\":\"${dep_uuid}\"}]}" "$code"
  else
    emit "{\"message\":\"stubbed trigger failure\"}" "$code"
  fi
  exit 0
fi

if [[ "$url" == *"/api/v1/deployments/"* ]]; then
  dep_uuid="${url##*/api/v1/deployments/}"
  key=$(sanitize "$dep_uuid")

  failvar="FAKE_CURL_FAIL_${key}"
  if [ "${!failvar:-0}" = "1" ]; then
    echo "fake-curl: simulated network failure polling $dep_uuid" >&2
    exit 7
  fi

  : "${FAKE_CURL_STATE_DIR:?FAKE_CURL_STATE_DIR must be set for a poll call}"
  mkdir -p "$FAKE_CURL_STATE_DIR"
  statefile="${FAKE_CURL_STATE_DIR}/${key}"
  idx=0
  [ -f "$statefile" ] && idx=$(cat "$statefile")

  seqvar="FAKE_CURL_SEQ_${key}"
  seq="${!seqvar:-finished}"
  IFS=',' read -ra parts <<<"$seq"
  last=$(( ${#parts[@]} - 1 ))
  use=$idx
  [ "$use" -gt "$last" ] && use=$last
  poll_status="${parts[$use]}"

  echo $((idx + 1)) > "$statefile"

  httpvar="FAKE_CURL_POLL_HTTP_${key}"
  code="${!httpvar:-200}"
  if [ "$code" -ge 200 ] && [ "$code" -lt 300 ]; then
    emit "{\"status\":\"${poll_status}\"}" "$code"
  else
    emit "{\"message\":\"stubbed poll failure\"}" "$code"
  fi
  exit 0
fi

# Anything else is smoke.sh's own request to a path on the site under test.
path="${url#*://}"
path="/${path#*/}"
key=$(sanitize "${path#/}")

failvar="FAKE_CURL_FAIL_${key}"
if [ "${!failvar:-0}" = "1" ]; then
  echo "fake-curl: simulated network failure requesting $path" >&2
  exit 7
fi

routevar="FAKE_CURL_ROUTE_${key}"
route="${!routevar:-}"
if [ -z "$route" ]; then
  emit "not found: $path" "404"
  exit 0
fi
code="${route%%:*}"
body="${route#*:}"
emit "$body" "$code"
