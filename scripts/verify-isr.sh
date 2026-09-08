#!/usr/bin/env bash
# Proves the phase gate: a redeploy does not cold-start the ISR cache.
#
# Builds, regenerates a page at runtime, wipes the container filesystem (by
# restoring the pristine post-build .next), restarts, and asserts the page comes
# back identical — which is only possible if it came from Redis.
set -uo pipefail
cd "$(dirname "$0")/.."

PORT=${PORT:-3101}
export DATABASE_URL=${DATABASE_URL:-postgres://directory:directory@localhost:5433/directory_dev}
export REDIS_URL=${REDIS_URL:-redis://localhost:6380}
export NEXT_PUBLIC_SITE_URL=${NEXT_PUBLIC_SITE_URL:-http://localhost:$PORT}
SLUG=${SLUG:-$(docker compose -f docker-compose.dev.yml exec -T postgres \
  psql -U directory -d directory_dev -tAc "select slug from cities order by listing_count desc limit 1" | tr -d ' ')}

boot() { corepack pnpm start -p "$PORT" > /tmp/verify-isr.log 2>&1 & echo $! > /tmp/verify-isr.pid
         until curl -sf "localhost:$PORT/$SLUG" >/dev/null 2>&1; do sleep 1; done; }
stop() { kill "$(cat /tmp/verify-isr.pid)" 2>/dev/null; lsof -ti:"$PORT" 2>/dev/null | xargs kill -9 2>/dev/null; }
body() { curl -s "localhost:$PORT/$SLUG" | md5; }

corepack pnpm build > /dev/null 2>&1 || { echo "build failed"; exit 1; }
rm -rf .next-pristine && cp -R .next .next-pristine

# Clear entries cached under a PREVIOUS build, or boot 1 serves a stale render
# and the comparison is meaningless.
docker compose -f docker-compose.dev.yml exec -T redis redis-cli FLUSHALL > /dev/null

echo "--- boot 1 ---"; boot
curl -s "localhost:$PORT/$SLUG" > /dev/null   # first render populates the cache
A=$(body); echo "checksum after build:      $A"
KEY=$(docker compose -f docker-compose.dev.yml exec -T redis redis-cli EXISTS "nextjs:/$SLUG" | tr -d ' \r')
echo "cached in redis:           $KEY"
stop

echo "--- simulating redeploy: pristine filesystem, same Redis ---"
rm -rf .next && cp -R .next-pristine .next

echo "--- boot 2 ---"; boot
B=$(body); echo "checksum after redeploy:   $B"
grep -m1 -E "REDIS CONNECTED|FALLING BACK" /tmp/verify-isr.log || true
stop
rm -rf .next-pristine

KEY2=$(docker compose -f docker-compose.dev.yml exec -T redis redis-cli EXISTS "nextjs:/$SLUG" | tr -d ' \r')
if [ "$A" = "$B" ] && [ -n "$A" ] && [ "$KEY" = "1" ] && [ "$KEY2" = "1" ]; then
  echo "PASS: /$SLUG is cached in redis and survived a filesystem wipe byte-for-byte"
else
  echo "FAIL: A=$A B=$B cachedBefore=$KEY cachedAfter=$KEY2"; exit 1
fi
