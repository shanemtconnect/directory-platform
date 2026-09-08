#!/bin/sh
# Keep old build assets servable across a redeploy.
#
# Since 2026-09-08 the ISR cache is keyed by build id, so a deploy no longer
# serves the previous build's HTML from the server — see
# docs/spikes/2026-09-07-phase-0-isr-cache-handler.md. That removes the reason
# this file was mandatory, but not the reason it is useful.
#
# Clients still hold pages from the previous build: an open tab, a bfcache
# entry, a prefetch in flight. Each references hashed asset paths —
# /_next/static/chunks/<hash>.css — and a redeploy replaces .next/static with
# new hashes, so those requests 404 until the client reloads.
#
# Vercel solves this by keeping old builds' static output around. Here that is a
# persistent volume: set STATIC_ASSETS_DIR to its mount path and each deploy adds
# its own hashes to it without clobbering the previous ones.
#
# Unset, this does nothing at all, and already-loaded pages lose their assets
# until they reload. It grows by one build per deploy and is never pruned.
set -eu

# The worker stage inherits this ENTRYPOINT but has no .next/static and serves
# nothing, so the retention dance is meaningless there — and worse, a worker
# sharing the volume would symlink a directory it must not own. It still wants
# the privilege drop at the bottom of this file, so guard the block rather than
# overriding the entrypoint.
#
# Match worker/index.ts's own check (`!== "true"`) exactly: WORKER_ENABLED is
# merely present in a web container that inherits it (e.g. =false) from a
# shared env file, and a presence check would silently skip retention there.
if [ -n "${STATIC_ASSETS_DIR:-}" ] && [ "${WORKER_ENABLED:-}" != "true" ]; then
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

    # Verify before destroying. This only proves every file the image shipped
    # exists on the volume — `[ -e ]` says nothing about its size or content,
    # so a file truncated mid-copy would still pass. Catching that is the
    # fatal, unguarded `cp` above: under `set -e` a copy that aborts partway
    # through kills the script before this loop, or the deletion below, ever
    # runs. What this loop catches instead is a file `cp -Rn` skipped
    # entirely — e.g. a per-file permission failure BusyBox does not
    # propagate as a nonzero exit — leaving the image's copy as the only
    # remaining source of it.
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
elif [ -n "${STATIC_ASSETS_DIR:-}" ]; then
  echo "[entrypoint] worker container: skipping static asset retention"
fi

# Drop privileges here rather than with USER, because the volume above is
# created root-owned. Already unprivileged (docker run --user) is fine too.
if [ "$(id -u)" = "0" ]; then
  exec su-exec nextjs:nodejs "$@"
fi
exec "$@"
