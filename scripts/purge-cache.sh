#!/usr/bin/env bash
# Sweep ISR cache namespaces this site no longer serves from.
#
# Keys are `nextjs:<buildId>:<path>`, so each build gets its own namespace and a
# deploy starts cold rather than serving the previous build's HTML with its dead
# asset hashes and unknown server-action ids. Nothing expires those old
# namespaces — so the app sweeps them itself a minute after each boot, see
# lib/cache/sweep.mjs. This script is the MANUAL equivalent, for a host that has
# a checkout and a redis-cli:
#
#   REDIS_URL="$REDIS_URL" ./scripts/purge-cache.sh
#
# It is deliberately not a platform post-deployment command: the runner image is
# node:24-alpine with the standalone server and nothing else — no scripts/, no
# bash, no redis-cli — so it cannot run in the container it would be aimed at.
#
# With no arguments it keeps the build id in .next/BUILD_ID (i.e. the build that
# is running) and deletes every other `nextjs:*` namespace, including the
# un-namespaced `nextjs:/path` keys written before this scheme existed.
#
#   KEEP_BUILD_ID=abc123   keep this namespace instead of reading .next/BUILD_ID
#   KEEP_BUILD_ID=none     keep nothing — purge every namespace, including the
#                          running build's. That is the old behaviour: use it to
#                          force every page to re-render now.
#   DRY_RUN=1              list what would go, delete nothing
#   CACHE_NAMESPACE=…      the namespace head, the same variable the app reads
#                          (lib/cache/build-id.mjs). Default `nextjs`.
#   PREFIX=nextjs:         the same thing spelled with its separator, for a
#                          namespace this checkout is not configured for.
#
# Scoping: REDIS_URL may carry a database index (redis://host:6379/7) and
# redis-cli honours it, so this only ever touches the db the app uses. If two
# sites do share a database, they must not share a namespace — this script and
# the app's own boot sweep both DEL everything under `<namespace>:*` that is not
# the running build's, so a shared namespace means each deploy wipes the other
# site's cache.
set -euo pipefail
cd "$(dirname "$0")/.."

# CACHE_NAMESPACE is what the app reads; PREFIX stays as the explicit override.
PREFIX="${PREFIX:-${CACHE_NAMESPACE:-nextjs}:}"
# Same character class lib/cache/build-id.mjs enforces, plus the one trailing
# colon. A `*` here would purge namespaces belonging to another site.
case "$PREFIX" in
  *[!A-Za-z0-9_-]*:) echo "purge-cache: invalid namespace: ${PREFIX%:}" >&2; exit 1 ;;
  ":" | "") echo "purge-cache: empty namespace" >&2; exit 1 ;;
  *:) ;;
  *) echo "purge-cache: PREFIX must end in a colon: $PREFIX" >&2; exit 1 ;;
esac
REDIS_URL="${REDIS_URL:-redis://localhost:6380}"
DRY_RUN="${DRY_RUN:-}"

command -v redis-cli > /dev/null || { echo "purge-cache: redis-cli not on PATH" >&2; exit 1; }

# Precedence matches lib/cache/build-id.mjs, so the script keeps exactly the
# namespace the running handler writes to.
KEEP="${KEEP_BUILD_ID:-}"
if [ -z "$KEEP" ]; then
  # `|| true` inside the braces, not after the pipe: `set -e` plus `pipefail`
  # would otherwise kill the script here rather than fall through to the
  # NEXT_BUILD_ID fallback and the error message below.
  KEEP=$({ cat .next/BUILD_ID 2>/dev/null || true; } | tr -d '[:space:]')
  [ -n "$KEEP" ] || KEEP="${NEXT_BUILD_ID:-}"
fi
if [ -z "$KEEP" ]; then
  echo "purge-cache: no .next/BUILD_ID and no KEEP_BUILD_ID." >&2
  echo "purge-cache: refusing to guess. Pass KEEP_BUILD_ID=<id>, or" >&2
  echo "purge-cache: KEEP_BUILD_ID=none to purge every namespace." >&2
  exit 1
fi

if [ "$KEEP" = "none" ]; then
  echo "keeping nothing — purging every ${PREFIX}* namespace"
  KEEP_PREFIX=""
else
  # Same character class the handler enforces. A `*` or `:` here would make the
  # "keep" test match namespaces it must not protect, or fail to match its own.
  case "$KEEP" in
    *[!A-Za-z0-9_-]* | "") echo "purge-cache: invalid build id: $KEEP" >&2; exit 1 ;;
  esac
  KEEP_PREFIX="${PREFIX}${KEEP}:"
  echo "keeping ${KEEP_PREFIX}*"
fi

# --scan, never KEYS: this Redis is shared and KEYS blocks it.
# awk with index(), not grep: the test must be "starts with", literally. A
# substring match would spare a key that merely mentions the kept prefix
# somewhere in its path, and a regex would have to escape the id.
DOOMED=$(redis-cli -u "$REDIS_URL" --scan --pattern "${PREFIX}*" \
  | awk -v keep="$KEEP_PREFIX" 'keep == "" || index($0, keep) != 1' || true)

N=$(printf '%s' "$DOOMED" | grep -c . || true)
if [ "$N" = "0" ]; then echo "nothing to purge"; exit 0; fi

if [ -n "$DRY_RUN" ]; then
  printf '%s\n' "$DOOMED" | sed 's/^/would delete /'
  echo "DRY_RUN: $N keys left in place"
  exit 0
fi

printf '%s\n' "$DOOMED" | xargs -r redis-cli -u "$REDIS_URL" DEL > /dev/null
echo "purged $N keys under ${PREFIX}*"
