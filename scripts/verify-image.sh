#!/usr/bin/env bash
# Proves the built image can actually do the things it silently could not.
#
# 1. `cache-handler.mjs` imports. Under pnpm's default layout the handler's
#    dependencies are symlinks into node_modules/.pnpm; copied piecemeal into the
#    image they dangle, the import throws, and Next falls back to a per-container
#    LRU — with no error anyone sees. Every deploy then throws away the cache.
# 2. The entrypoint retains .next/static on a volume ACROSS TWO DEPLOYS. One
#    container start only shows that a copy happened; the property that matters
#    is that the second start does not clobber the first's files. That is
#    checked with a sentinel written between the two starts.
# 3. The entrypoint refuses to boot on a read-only volume instead of deleting
#    the image's assets and reporting success — the exact bug this replaced.
# 4. The worker image runs the real `worker/index.ts` under tsx, which means the
#    whole import graph resolves, `@/lib/db/client` included. It is not run to
#    completion: it needs no Postgres to start, and would otherwise sit in cron
#    forever, so it is started with a timeout and asserted on its startup line.
#
# This cannot be a RUN step in the Dockerfile: importing the handler needs REDIS_URL.
#
#   ./scripts/verify-image.sh
set -euo pipefail
cd "$(dirname "$0")/.."

IMAGE=${IMAGE:-directory-platform:verify}
SITE_URL=${NEXT_PUBLIC_SITE_URL:-http://localhost:3000}

# `next build` prerenders /, /cities and /categories, so it really does query the
# database — the image cannot be built against a placeholder URL. From inside the
# build container the host's dev Postgres is host.docker.internal.
BUILD_DB=${BUILD_DATABASE_URL:-postgres://directory:directory@host.docker.internal:5433/directory_dev}
# Database index 5: the dev Redis on 6380 is shared with other work, and nothing
# here may disturb it.
RUNTIME_REDIS=${RUNTIME_REDIS_URL:-redis://host.docker.internal:6380/5}

build() {
  docker build --target "$1" \
    --add-host=host.docker.internal:host-gateway \
    --build-arg NEXT_PUBLIC_SITE_URL="$SITE_URL" \
    --build-arg DATABASE_URL="$BUILD_DB" \
    -t "$2" .
}

fail() { echo "FAIL: $*" >&2; exit 1; }

echo "--- building runner ---"
build runner "$IMAGE"

echo "--- cache handler imports ---"
docker run --rm "$IMAGE" \
  node -e "import('./cache-handler.mjs').then(()=>console.log('ok'))"

echo "--- deploy 1: assets land on an empty volume ---"
VOL=$(docker volume create)
trap 'docker volume rm -f "$VOL" > /dev/null 2>&1 || true' EXIT
docker run --rm -e STATIC_ASSETS_DIR=/data/next-static -v "$VOL":/data/next-static "$IMAGE" \
  sh -c '[ -L /app/.next/static ] && [ -n "$(ls -A /data/next-static)" ] && echo ok' \
  || fail "first start did not populate the volume"

# A file only the *previous* deploy shipped. Real life is a chunk hash that this
# build no longer produces but cached HTML still asks for.
echo "--- placing a previous-deploy sentinel on the volume ---"
docker run --rm -v "$VOL":/data/next-static "$IMAGE" \
  sh -c 'mkdir -p /data/next-static/chunks && echo previous-deploy > /data/next-static/chunks/old-deploy-hash.css'

echo "--- deploy 2: same volume, sentinel survives and this build is present ---"
docker run --rm -e STATIC_ASSETS_DIR=/data/next-static -v "$VOL":/data/next-static "$IMAGE" sh -c '
  set -e
  [ "$(cat /data/next-static/chunks/old-deploy-hash.css)" = "previous-deploy" ] \
    || { echo "sentinel was clobbered or lost"; exit 1; }
  # …and this build is really there too, not just the old files.
  [ -d /data/next-static/chunks ] || { echo "no chunks dir"; exit 1; }
  [ "$(find /data/next-static -type f ! -name old-deploy-hash.css | wc -l)" -gt 0 ] \
    || { echo "this build contributed no files"; exit 1; }
  [ -L /app/.next/static ] || { echo ".next/static is not a symlink"; exit 1; }
  echo "ok: previous deploy retained alongside this one"
' || fail "second deploy did not retain the previous deploy's assets"

echo "--- read-only volume: refuses to boot rather than destroying the assets ---"
set +e
RO_OUT=$(docker run --rm -e STATIC_ASSETS_DIR=/data/next-static -v "$VOL":/data/next-static:ro \
  "$IMAGE" sh -c 'echo SHOULD_NOT_REACH_HERE' 2>&1)
RO_CODE=$?
set -e
[ "$RO_CODE" -ne 0 ] || fail "read-only volume was accepted (exit 0) — the guard does not work"
grep -q "is not writable" <<<"$RO_OUT" || fail "no clear message on a read-only volume: $RO_OUT"
if grep -q "SHOULD_NOT_REACH_HERE" <<<"$RO_OUT"; then fail "the server ran despite an unusable assets dir"; fi
echo "ok: exit $RO_CODE, and it said why"

echo "--- building worker ---"
build worker "$IMAGE-worker"

echo "--- worker: the real entrypoint starts and resolves @/lib/db/client ---"
# WORKER_ENABLED=true so this is the genuine startup path, not the early exit.
# No Postgres is contacted at startup (node-postgres connects lazily; the first
# cron tick is a minute away), so reaching "[worker] started" proves every
# top-level import resolved — @/lib/db/client among them.
set +e
W_OUT=$(docker run --rm --add-host=host.docker.internal:host-gateway \
  -e WORKER_ENABLED=true \
  -e NEXT_PUBLIC_SITE_URL="$SITE_URL" \
  -e DATABASE_URL="$BUILD_DB" \
  -e REDIS_URL="$RUNTIME_REDIS" \
  "$IMAGE-worker" timeout -s TERM 20 ./node_modules/.bin/tsx worker/index.ts 2>&1)
set -e
grep -q "\[worker\] started" <<<"$W_OUT" || fail "worker did not start: $W_OUT"
if grep -qi "cannot find\|ERR_MODULE_NOT_FOUND\|Cannot find package" <<<"$W_OUT"; then
  fail "worker had unresolved imports: $W_OUT"
fi
echo "ok: $(grep -c '^\[worker\]' <<<"$W_OUT") worker startup lines, no unresolved imports"

echo "--- worker: missing env stops the process instead of idling ---"
set +e
E_OUT=$(docker run --rm -e WORKER_ENABLED=true -e NEXT_PUBLIC_SITE_URL="$SITE_URL" \
  "$IMAGE-worker" ./node_modules/.bin/tsx worker/index.ts 2>&1)
E_CODE=$?
set -e
[ "$E_CODE" -ne 0 ] || fail "worker booted with no DATABASE_URL/REDIS_URL"
echo "ok: exit $E_CODE"

echo "PASS: cache handler loads, assets survive a redeploy, a read-only volume"
echo "      fails the boot, and the worker runs its real entrypoint."
