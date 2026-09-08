#!/bin/sh
# Keep old build assets servable across a redeploy.
#
# The ISR cache is Redis-backed and deliberately survives a deploy, but the HTML
# it holds references hashed asset paths — /_next/static/chunks/<hash>.css — from
# the build that produced it. A redeploy replaces .next/static with new hashes,
# so every cached page then loads with dead CSS and JS. That is what a cached
# homepage linking a 404ing stylesheet looked like in practice.
#
# Vercel solves this by keeping old builds' static output around. Here that is a
# persistent volume: set STATIC_ASSETS_DIR to its mount path and each deploy adds
# its own hashes to it without clobbering the previous ones.
#
# Unset, this does nothing at all — in which case run scripts/purge-cache.sh
# after every deploy, or serve cached HTML that points at files you deleted.
set -eu

# The worker stage inherits this ENTRYPOINT but has no .next/static and serves
# nothing, so the retention dance is meaningless there — and worse, a worker
# sharing the volume would symlink a directory it must not own. It still wants
# the privilege drop at the bottom of this file, so guard the block rather than
# overriding the entrypoint.
if [ -n "${STATIC_ASSETS_DIR:-}" ] && [ -z "${WORKER_ENABLED:-}" ]; then
  # `mkdir -p` on a directory that already exists exits 0 whether or not it can
  # be written to, so it proves nothing about a read-only mount. The only honest
  # probe is a real write.
  mkdir -p "$STATIC_ASSETS_DIR" 2>/dev/null || true
  if ! touch "$STATIC_ASSETS_DIR/.write-probe" 2>/dev/null; then
    echo "[entrypoint] STATIC_ASSETS_DIR=$STATIC_ASSETS_DIR is not writable." >&2
    echo "[entrypoint] Mount a writable volume there, or unset it and purge the" >&2
    echo "[entrypoint] ISR cache after each deploy. Refusing to boot: serving" >&2
    echo "[entrypoint] cached HTML with dead assets is worse than not starting." >&2
    exit 1
  fi
  rm -f "$STATIC_ASSETS_DIR/.write-probe"

  if [ -d /app/.next/static ] && [ ! -L /app/.next/static ]; then
    if [ -z "$(ls -A /app/.next/static)" ]; then
      echo "[entrypoint] /app/.next/static is empty — this image has no assets to serve." >&2
      exit 1
    fi

    # -n: never overwrite. Identical hashes are identical files; differing ones
    # are the previous deploy's, and those are the whole point.
    #
    # The source is globbed rather than written `static/.` — BusyBox cp accepts
    # the `/.` form, exits 0, and copies nothing at all, which leaves an empty
    # volume and a 404 for every asset on the page.
    #
    # No `|| true`, and no 2>/dev/null: `set -e` must see a failed copy. The
    # earlier version swallowed it, deleted the image's copy on the next line,
    # and printed a success message over an empty directory.
    cp -Rn /app/.next/static/* "$STATIC_ASSETS_DIR/"

    # Verify before destroying. `cp -Rn` can exit 0 having copied less than
    # everything (a full disk mid-copy, a per-file permission failure BusyBox
    # does not propagate), and the image's copy is the only remaining source of
    # these files. Every file the image shipped must be on the volume first.
    missing=$(cd /app/.next/static && find . -type f | while read -r f; do
      [ -e "$STATIC_ASSETS_DIR/$f" ] || echo "$f"
    done | head -n 5)
    if [ -n "$missing" ]; then
      echo "[entrypoint] Copy to $STATIC_ASSETS_DIR is incomplete. Missing, e.g.:" >&2
      echo "$missing" | sed 's/^/[entrypoint]   /' >&2
      echo "[entrypoint] Keeping the image's copy and refusing to boot rather than" >&2
      echo "[entrypoint] deleting the only files that can serve this build." >&2
      exit 1
    fi

    rm -rf /app/.next/static
  fi
  ln -sfn "$STATIC_ASSETS_DIR" /app/.next/static
  chown -R nextjs:nodejs "$STATIC_ASSETS_DIR" 2>/dev/null || true
  echo "[entrypoint] .next/static -> $STATIC_ASSETS_DIR (assets retained across deploys)"
fi

# Drop privileges here rather than with USER, because the volume above is
# created root-owned. Already unprivileged (docker run --user) is fine too.
if [ "$(id -u)" = "0" ]; then
  exec su-exec nextjs:nodejs "$@"
fi
exec "$@"
