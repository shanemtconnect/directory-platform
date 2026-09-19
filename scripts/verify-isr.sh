#!/usr/bin/env bash
# Proves what the Redis ISR cache is actually for, after the 2026-09-08 reversal.
#
# It is NOT "the cache survives a redeploy". Cached HTML belongs to the build
# that rendered it: it links `/_next/static/chunks/<hash>.css` from that build,
# and its forms post to that build's server-action ids. Serving it from a newer
# build gives an unstyled page and a form that fails every POST until the entry
# revalidates. Keys are namespaced `nextjs:<buildId>:` so that cannot happen.
#
# What the cache IS for, and what this script asserts:
#
#   A. A page regenerated at RUNTIME survives a process/container restart of the
#      SAME build. That is the shared, replica-spanning, restart-surviving cache
#      the design wanted, and it is the half that still holds.
#   B. After a REBUILD the same URL is served fresh from the new build: the new
#      build id appears in the HTML, the old one does not, and the stylesheet
#      the page links returns 200 (the assertion the previous version of this
#      script added, and the symptom that started all this).
#   C. scripts/purge-cache.sh then sweeps the orphaned namespace and leaves the
#      running build's alone.
#
# A is only provable with a page whose content is not reproducible from the
# build output, so the script writes a throwaway `/isr-probe/[id]` route that
# prints Date.now() and returns no `generateStaticParams` — exactly how the real
# city and listing pages behave: nothing is prerendered, every path is rendered
# on demand and then cached. It is removed on exit.
#
#   REDIS_URL=redis://localhost:6380/9 ./scripts/verify-isr.sh
#
# The Redis on :6380 is shared. This never FLUSHALLs; it FLUSHDBs one database
# index, taken from REDIS_URL, and refuses to run against index 0.
set -uo pipefail
cd "$(dirname "$0")/.."

PORT=${PORT:-3101}
export DATABASE_URL=${DATABASE_URL:-postgres://directory:directory@localhost:5433/directory_dev}
export REDIS_URL=${REDIS_URL:-redis://localhost:6380/9}
export NEXT_PUBLIC_SITE_URL=${NEXT_PUBLIC_SITE_URL:-http://localhost:$PORT}

RDB=${REDIS_URL##*/}
case "$RDB" in
  ''|*[!0-9]*) echo "REDIS_URL must end in a database index, e.g. redis://host:6380/9"; exit 1 ;;
  0) echo "Refusing to run against Redis db 0: it is shared. Use e.g. /9."; exit 1 ;;
esac
# Prefer the host redis-cli (what purge-cache.sh needs anyway); fall back to the
# dev container. `-p directory-platform` is not optional: run from a git
# worktree, compose would otherwise derive its project name from the worktree
# directory and report the shared dev redis as "not running".
if command -v redis-cli > /dev/null; then
  redis() { redis-cli -u "$REDIS_URL" "$@"; }
else
  redis() { docker compose -p directory-platform -f docker-compose.dev.yml exec -T redis redis-cli -n "$RDB" "$@"; }
fi

PROBE=app/isr-probe/[id]/page.tsx
PROBE_URL=/isr-probe/one
GLOBALS=app/globals.css
# .next/types holds a generated validator that imports every route, including
# the probe. Left behind it fails `pnpm typecheck` — tsconfig includes
# `.next/types/**/*.ts` — with an error about a file this script deleted. Next
# regenerates the directory on the next build or dev run.
cleanup() { stop 2>/dev/null; rm -rf app/isr-probe .next-pristine .next/types
            [ -f /tmp/verify-isr-globals.bak ] && mv /tmp/verify-isr-globals.bak "$GLOBALS"; }
# Ctrl-C or a TERM mid-build would otherwise leave the probe route and an extra
# rule in app/globals.css in the working tree. The signal handlers `exit` rather
# than calling cleanup themselves: that runs the EXIT trap, so cleanup happens
# exactly once and the script actually stops instead of resuming at the next
# command with its server killed underneath it.
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

boot() { corepack pnpm start -p "$PORT" >> /tmp/verify-isr.log 2>&1 & echo $! > /tmp/verify-isr.pid; disown
         # Readiness polls `/`, never the probe. The first probe request after
         # a boot is the whole experiment — a cold cache renders a new
         # timestamp, a warm one replays the stored render — so it must be the
         # script's, not a readiness check's.
         for _ in $(seq 60); do curl -sf "localhost:$PORT/" >/dev/null 2>&1 && return 0; sleep 1; done
         echo "server did not come up; see /tmp/verify-isr.log"; exit 1; }
stop() { kill "$(cat /tmp/verify-isr.pid 2>/dev/null)" 2>/dev/null
         lsof -ti:"$PORT" 2>/dev/null | xargs kill -9 2>/dev/null; }
probe() { curl -s "localhost:$PORT$PROBE_URL" | grep -o 'probe:[0-9]\+' | head -1; }
css()   { curl -s "localhost:$PORT/" | grep -o '/_next/static/[^"]*\.css' | head -1; }
home()  { curl -s "localhost:$PORT/"; }
code()  { curl -s -o /dev/null -w "%{http_code}" "localhost:$PORT$1"; }
# `exit` here would only leave the $(build) subshell, and the message would
# become the build id every later comparison is made against. Fail through the
# status instead; every caller is `B=$(build) || die`.
build() { corepack pnpm build > /tmp/verify-isr-build.log 2>&1 || return 1
          tr -d '[:space:]' < .next/BUILD_ID; }
die_build() { echo "build failed, see /tmp/verify-isr-build.log"; exit 1; }

: > /tmp/verify-isr.log
mkdir -p "$(dirname "$PROBE")"
cat > "$PROBE" <<'TSX'
// Written and deleted by scripts/verify-isr.sh. If you are reading this in a
// commit, the script died before its EXIT trap ran — delete app/isr-probe.
//
// `generateStaticParams` returning [] is the point: nothing is prerendered, so
// the first request renders at runtime and the timestamp exists nowhere in the
// build output. An hour of revalidate keeps that entry fresh for the whole run,
// which is what makes the comparisons deterministic — with a short window every
// request would serve stale and start a regeneration, and the value would move
// under the test.
export const revalidate = 3600;

export function generateStaticParams(): { id: string }[] {
  return [];
}

export default async function IsrProbe({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // One template string, not `probe:{Date.now()}` — React would render a
  // comment node between two children and the script's grep would miss it.
  return <pre>{`probe:${Date.now()}:${id}`}</pre>;
}
TSX

echo "=== build 1 ==="
B1=$(build) || die_build; echo "build id: $B1"
rm -rf .next-pristine && cp -R .next .next-pristine
redis FLUSHDB > /dev/null   # this index only; :6380/0 belongs to other work

boot
T_RUNTIME=$(probe); echo "rendered at runtime:        ${T_RUNTIME:-NONE}"
T_AGAIN=$(probe);   echo "second hit, same process:   ${T_AGAIN:-NONE}"
CSS1=$(css);        echo "stylesheet, build 1:        $CSS1"
stop

echo "=== A: restart the same build (new container, same image, warm Redis) ==="
# Pristine .next is the container filesystem as the image ships it. The probe's
# timestamp is in no file there, so reading it back after the restart is only
# possible from Redis; a cold cache would render a new one.
rm -rf .next && cp -R .next-pristine .next
boot
T_RESTART=$(probe); echo "after restart:              $T_RESTART"
grep -m1 -E "REDIS CONNECTED|FALLING BACK" /tmp/verify-isr.log || true
grep -m1 "key prefix" /tmp/verify-isr.log || true
KEY_B1=$(redis --scan --pattern "nextjs:$B1:*isr-probe*" | grep -c . )
echo "build 1 probe keys:         $KEY_B1"
stop

echo "=== B: rebuild (new build id, new asset hashes) ==="
# A real deploy ships changed source. Appending to the global stylesheet is the
# smallest honest version of that: it changes the CSS content hash, so build 1's
# stylesheet URL genuinely stops existing.
cp "$GLOBALS" /tmp/verify-isr-globals.bak
printf '\n/* verify-isr.sh: forces a new asset hash */\n.verify-isr{outline:0}\n' >> "$GLOBALS"
B2=$(build) || die_build; echo "build id: $B2"
mv /tmp/verify-isr-globals.bak "$GLOBALS"

boot
HTML=$(home)
CSS2=$(css);        echo "stylesheet, build 2:        $CSS2"
C2=$(code "$CSS2"); echo "  status:                   $C2"
C1=$(code "$CSS1"); echo "build 1's stylesheet:       $C1 (gone, as after any deploy)"
T_REBUILD=$(probe); echo "probe after rebuild:        $T_REBUILD"
# -e: nanoid build ids may begin with `-`, which grep would read as an option.
HAS_B2=$(printf '%s' "$HTML" | grep -c -e "$B2"); echo "new build id in HTML:       $HAS_B2"
HAS_B1=$(printf '%s' "$HTML" | grep -c -e "$B1"); echo "old build id in HTML:       $HAS_B1"
stop

# purge-cache.sh hard-requires a redis-cli of its own; this script's redis()
# helper can fall back to the dev container, but the script under test cannot.
# So section C either runs or is announced as skipped — it must never print its
# banner over invented NS_AFTER/NS_KEPT values that satisfy the assertions
# below without anything having been purged.
if command -v redis-cli > /dev/null; then
  PURGE_RAN=1
  echo "=== C: purge-cache.sh sweeps the orphaned namespace ==="
  NS_BEFORE=$(redis --scan --pattern "nextjs:$B1:*" | grep -c . )
  echo "build 1 keys before purge:  $NS_BEFORE"
  KEEP_BUILD_ID="$B2" ./scripts/purge-cache.sh
  NS_AFTER=$(redis --scan --pattern "nextjs:$B1:*" | grep -c . )
  NS_KEPT=$(redis --scan --pattern "nextjs:$B2:*" | grep -c . )
  echo "build 1 keys after purge:   $NS_AFTER"
  echo "build 2 keys after purge:   $NS_KEPT"
else
  PURGE_RAN=0
  echo "=== C: SKIPPED — scripts/purge-cache.sh needs a redis-cli on PATH ==="
  echo "    (A and B above still ran; nothing below asserts anything about the purge.)"
fi

fail=""
[ -n "$T_RUNTIME" ]                || fail="$fail probe-never-rendered"
[ "$T_AGAIN" = "$T_RUNTIME" ]      || fail="$fail not-cached-within-one-process($T_RUNTIME/$T_AGAIN)"
[ "$T_RESTART" = "$T_RUNTIME" ]    || fail="$fail cold-after-restart(runtime=$T_RUNTIME restart=$T_RESTART)"
[ "$KEY_B1" != "0" ]               || fail="$fail not-in-redis"
[ -n "$CSS1" ] && [ -n "$CSS2" ]   || fail="$fail no-stylesheet-in-page"
[ "$CSS1" != "$CSS2" ]             || fail="$fail rebuild-did-not-change-asset-hashes"
[ "$C2" = "200" ]                  || fail="$fail stylesheet-dead-after-rebuild(got=$C2)"
[ -n "$T_REBUILD" ]                || fail="$fail probe-missing-after-rebuild"
[ "$T_REBUILD" != "$T_RUNTIME" ]   || fail="$fail served-previous-builds-html"
[ "$HAS_B2" != "0" ]               || fail="$fail new-build-id-absent-from-html"
[ "$HAS_B1" = "0" ]                || fail="$fail old-build-id-still-in-html"
if [ "$PURGE_RAN" = "1" ]; then
  [ "$NS_BEFORE" != "0" ]          || fail="$fail nothing-cached-under-build-1"
  [ "$NS_AFTER" = "0" ]            || fail="$fail purge-left-the-old-namespace($NS_AFTER)"
  [ "$NS_KEPT" != "0" ]            || fail="$fail purge-ate-the-running-builds-namespace"
fi

if [ -z "$fail" ]; then
  echo
  echo "PASS: a runtime-regenerated page survived a restart of the same build,"
  echo "      and a rebuild served it fresh with a live stylesheet"
  if [ "$PURGE_RAN" = "1" ]; then
    echo "      — and purge-cache.sh swept the old namespace without touching the running one"
  else
    echo "      (purge-cache.sh unverified: no redis-cli on this host)"
  fi
else
  echo; echo "FAIL:$fail"; exit 1
fi
