#!/usr/bin/env bash
# Purge this site's ISR cache from the shared Redis.
#
# Rarely needed: ISR pages are MEANT to survive a deploy, and each picks up new
# code when its `revalidate` window lapses. Use this when a deploy changes
# something with no revalidate window, or when you need every page rebuilt now.
#
# One case makes it mandatory rather than rare. Cached HTML references the
# hashed asset paths of the build that produced it, so unless the app mounts a
# persistent volume at STATIC_ASSETS_DIR — which keeps the previous build's
# .next/static servable, see docker-entrypoint.sh — every page in this cache is
# pointing at CSS and JS the new deploy deleted. Without that volume, run this
# after EVERY deploy.
#
#   REDIS_URL=redis://host:6379 PREFIX=nextjs: ./scripts/purge-cache.sh
set -euo pipefail
PREFIX="${PREFIX:-nextjs:}"
REDIS_URL="${REDIS_URL:-redis://localhost:6380}"
N=$(redis-cli -u "$REDIS_URL" --scan --pattern "${PREFIX}*" | wc -l | tr -d ' ')
redis-cli -u "$REDIS_URL" --scan --pattern "${PREFIX}*" | xargs -r redis-cli -u "$REDIS_URL" DEL > /dev/null
echo "purged $N keys matching ${PREFIX}*"
