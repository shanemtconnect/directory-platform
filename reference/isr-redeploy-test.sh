#!/bin/bash
cd "$(dirname "$0")"
export REDIS_URL=redis://localhost:6399
tok() { curl -s localhost:3399/isr | sed -n 's/.*id="token">\([^<]*\)<.*/\1/p'; }
up() { until curl -sf localhost:3399/isr >/dev/null 2>&1; do sleep 1; done; }
boot() { corepack pnpm start > server.log 2>&1 & echo $! > server.pid; up; }
stop() { kill "$(cat server.pid)" 2>/dev/null; wait "$(cat server.pid)" 2>/dev/null; }

rm -rf .next-pristine && cp -R .next .next-pristine
docker exec spike-redis redis-cli FLUSHALL >/dev/null

echo "--- boot #1 ---"; boot
grep -E "REDIS CONNECTED|FALLING BACK" server.log | head -2
T1=$(tok); echo "T1 (build-time prerender): $T1"
curl -s localhost:3399/api/revalidate >/dev/null
T2=$(tok); echo "T2 (runtime regenerated):  $T2"
echo "redis keys after T2: $(docker exec spike-redis redis-cli DBSIZE)"
docker exec spike-redis redis-cli --scan --pattern 'spike:*' | head -5
stop

echo "--- simulating redeploy: wiping container filesystem, keeping Redis ---"
rm -rf .next && cp -R .next-pristine .next

echo "--- boot #2 ---"; boot
grep -E "REDIS CONNECTED|FALLING BACK" server.log | head -2
T3=$(tok); echo "T3 (after redeploy):       $T3"
stop

echo
if [ "$T3" = "$T2" ] && [ -n "$T2" ] && [ "$T1" != "$T2" ]; then
  echo "PASS: runtime-regenerated page survived a filesystem wipe -> served from Redis"
elif [ "$T3" = "$T1" ]; then
  echo "FAIL: fell back to build-time artifact -> Redis cache NOT used"
else
  echo "FAIL: T1=$T1 T2=$T2 T3=$T3"
fi
