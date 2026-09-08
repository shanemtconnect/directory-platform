#!/usr/bin/env bash
# Proves the built image can actually do the three things it silently could not.
#
# 1. `cache-handler.mjs` imports. Under pnpm's default layout the handler's
#    dependencies are symlinks into node_modules/.pnpm; copied piecemeal into the
#    image they dangle, the import throws, and Next falls back to a per-container
#    LRU — with no error anyone sees. Every deploy then throws away the cache.
# 2. The worker image has `tsx`, and it resolves the `@/…` tsconfig alias.
#    `node --experimental-strip-types` does not, so the worker crashed on boot.
# 3. The entrypoint retains .next/static on a volume, which is what keeps
#    ISR-cached HTML from linking assets the last deploy deleted.
#
# This cannot be a RUN step in the Dockerfile: importing the handler needs REDIS_URL.
#
#   ./scripts/verify-image.sh
set -euo pipefail
cd "$(dirname "$0")/.."

IMAGE=${IMAGE:-directory-platform:verify}
SITE_URL=${NEXT_PUBLIC_SITE_URL:-http://localhost:3000}

# `next build` prerenders /cities and the city pages, so it really does query the
# database — the image cannot be built against a placeholder URL. From inside the
# build container the host's dev Postgres is host.docker.internal.
BUILD_DB=${BUILD_DATABASE_URL:-postgres://directory:directory@host.docker.internal:5433/directory_dev}

build() {
  docker build --target "$1" \
    --add-host=host.docker.internal:host-gateway \
    --build-arg NEXT_PUBLIC_SITE_URL="$SITE_URL" \
    --build-arg DATABASE_URL="$BUILD_DB" \
    -t "$2" .
}

echo "--- building runner ---"
build runner "$IMAGE"

echo "--- cache handler imports ---"
docker run --rm "$IMAGE" \
  node -e "import('./cache-handler.mjs').then(()=>console.log('ok'))"

echo "--- static assets are retained on a volume ---"
VOL=$(docker volume create)
trap 'docker volume rm -f "$VOL" > /dev/null' EXIT
docker run --rm -e STATIC_ASSETS_DIR=/data/next-static -v "$VOL":/data/next-static "$IMAGE" \
  sh -c '[ -L /app/.next/static ] && [ -n "$(ls -A /data/next-static)" ] && echo ok'

echo "--- building worker ---"
build worker "$IMAGE-worker"

echo "--- worker runs tsx and resolves the @/ alias ---"
docker run --rm "$IMAGE-worker" \
  ./node_modules/.bin/tsx -e "import('@/config/site.config').then(m=>console.log('ok', m.siteConfig.country))"

echo "PASS: image loads the cache handler, retains assets, and can run the worker"
