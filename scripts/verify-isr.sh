#!/usr/bin/env bash
# Proves the phase gate: a redeploy does not cold-start the ISR cache.
#
# Builds, regenerates a page at runtime, wipes the container filesystem (by
# restoring the pristine post-build .next), restarts, and asserts the page comes
# back identical — which is only possible if it came from Redis.
#
# Then the second half, which is the check that was missing. Surviving the
# redeploy is not enough if what survives is HTML pointing at assets the new
# build no longer has: a cached homepage linking a CSS chunk that 404s renders
# unstyled. So it also simulates a rebuild that changes the asset hashes and
# asserts that the stylesheet the cached page asks for is still served — first
# proving it is NOT, without the retention that docker-entrypoint.sh performs.
set -uo pipefail
cd "$(dirname "$0")/.."

PORT=${PORT:-3101}
export DATABASE_URL=${DATABASE_URL:-postgres://directory:directory@localhost:5433/directory_dev}
export REDIS_URL=${REDIS_URL:-redis://localhost:6380}
export NEXT_PUBLIC_SITE_URL=${NEXT_PUBLIC_SITE_URL:-http://localhost:$PORT}
SLUG=${SLUG:-$(docker compose -f docker-compose.dev.yml exec -T postgres \
  psql -U directory -d directory_dev -tAc "select slug from cities order by listing_count desc limit 1" | tr -d ' ')}
# Stands in for the volume the deployed app mounts at STATIC_ASSETS_DIR.
RETAIN=${RETAIN:-/tmp/verify-isr-static}

boot() { corepack pnpm start -p "$PORT" > /tmp/verify-isr.log 2>&1 & echo $! > /tmp/verify-isr.pid
         until curl -sf "localhost:$PORT/$SLUG" >/dev/null 2>&1; do sleep 1; done; }
stop() { kill "$(cat /tmp/verify-isr.pid)" 2>/dev/null; lsof -ti:"$PORT" 2>/dev/null | xargs kill -9 2>/dev/null; }
body() { curl -s "localhost:$PORT/$SLUG" | md5; }
css()  { curl -s "localhost:$PORT/$SLUG" | grep -o '/_next/static/[^"]*\.css' | head -1; }
code() { curl -s -o /dev/null -w "%{http_code}" "localhost:$PORT$1"; }

corepack pnpm build > /dev/null 2>&1 || { echo "build failed"; exit 1; }
rm -rf .next-pristine && cp -R .next .next-pristine

# Clear entries cached under a PREVIOUS build, or boot 1 serves a stale render
# and the comparison is meaningless.
docker compose -f docker-compose.dev.yml exec -T redis redis-cli FLUSHALL > /dev/null

echo "--- boot 1 ---"; boot
curl -s "localhost:$PORT/$SLUG" > /dev/null   # first render populates the cache
A=$(body); echo "checksum after build:      $A"
CSS=$(css); echo "stylesheet in cached page: ${CSS:-none found}"
KEY=$(docker compose -f docker-compose.dev.yml exec -T redis redis-cli EXISTS "nextjs:/$SLUG" | tr -d ' \r')
echo "cached in redis:           $KEY"
stop

echo "--- simulating redeploy: pristine filesystem, same Redis ---"
rm -rf .next && cp -R .next-pristine .next

echo "--- boot 2 ---"; boot
B=$(body); echo "checksum after redeploy:   $B"
grep -m1 -E "REDIS CONNECTED|FALLING BACK" /tmp/verify-isr.log || true
stop

KEY2=$(docker compose -f docker-compose.dev.yml exec -T redis redis-cli EXISTS "nextjs:/$SLUG" | tr -d ' \r')

# A real redeploy ships new content hashes. Renaming the chunk directory is the
# cheap equivalent: every /_next/static/chunks/… URL the cached HTML holds is
# now gone, exactly as it would be after any source change.
echo "--- simulating a rebuild that changes every asset hash ---"
rm -rf "$RETAIN" && mkdir -p "$RETAIN" && cp -R .next/static/* "$RETAIN"/
rm -rf .next && cp -R .next-pristine .next
mv .next/static/chunks .next/static/chunks-rebuilt

echo "--- boot 3: cached HTML, new hashes, no STATIC_ASSETS_DIR ---"; boot
C_WITHOUT=$(code "$CSS"); echo "stylesheet without retention: $C_WITHOUT (404 is the bug)"
stop

# What docker-entrypoint.sh does on boot when STATIC_ASSETS_DIR is set.
cp -Rn "$RETAIN"/* .next/static/ 2>/dev/null

echo "--- boot 4: same, with the previous deploy's assets retained ---"; boot
C_WITH=$(code "$CSS"); echo "stylesheet with retention:    $C_WITH"
stop

rm -rf .next-pristine "$RETAIN"

fail=""
[ "$A" = "$B" ] && [ -n "$A" ] || fail="$fail cached-html-changed(A=$A B=$B)"
[ "$KEY" = "1" ] && [ "$KEY2" = "1" ] || fail="$fail not-in-redis(before=$KEY after=$KEY2)"
[ -n "$CSS" ] || fail="$fail no-stylesheet-in-page"
[ "$C_WITHOUT" = "404" ] || fail="$fail expected-404-without-retention(got=$C_WITHOUT)"
[ "$C_WITH" = "200" ] || fail="$fail stylesheet-dead-after-rebuild(got=$C_WITH)"

if [ -z "$fail" ]; then
  echo "PASS: /$SLUG survived a filesystem wipe byte-for-byte, and its stylesheet"
  echo "      still returns 200 after a rebuild that changed every asset hash"
else
  echo "FAIL:$fail"; exit 1
fi
