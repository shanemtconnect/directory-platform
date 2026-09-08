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
# 5. `node scripts/migrate.mjs` runs standalone in this image, and the image
#    carries prod deps only — so `drizzle/` or a missed dependency is a deploy
#    that dies at the first step, or worse, a container that serves a site
#    whose every enquiry form fails on a missing `job_queue` column.
# 6. The WORKER can seed the database the runner just migrated. Seeding needs
#    tsx and `seeds/`, which only this stage has. Run against the same throwaway
#    database as (5) on purpose: it is the real first-deploy order, and it
#    proves the two images agree about the schema rather than each being
#    self-consistent in isolation.
# 7. SITE_ENV really is a build arg. `next.config.ts` `headers()` runs during
#    the build and is frozen into routes-manifest.json, and
#    `validateProductionConfig` runs there too — so a missing `ARG SITE_ENV`
#    means a staging image on a real subdomain cannot be built at all, and the
#    noindex header can never be flipped without a rebuild. Checked from both
#    sides: SITE_ENV=staging on a reachable origin builds, and omitting it on
#    the same origin fails on the placeholder guard.
# 8. MIGRATE_ON_BOOT=true actually migrates before serving. Coolify's
#    pre-deployment command runs in the PREVIOUS container, so it never runs
#    on a first deploy and would run the OLD image's migrator on later ones —
#    the entrypoint of the NEW container is the only correct place. Checked
#    end to end: a fresh throwaway database gets all 8 migrations applied and
#    `/pricing` returns 200 once the container is up, and a wrong
#    `DATABASE_URL` exits the container non-zero instead of serving anyway.
#
# This cannot be a RUN step in the Dockerfile: importing the handler needs REDIS_URL.
#
#   ./scripts/verify-image.sh
set -euo pipefail
cd "$(dirname "$0")/.."

IMAGE=${IMAGE:-directory-platform:verify}
SITE_URL=${NEXT_PUBLIC_SITE_URL:-http://localhost:3000}

# The build takes no DATABASE_URL: the three prerendered routes ask
# `prerenderingWithoutDatabase()` first and emit their empty-state shell. This
# is the dev database the WORKER is pointed at below, at runtime, where a
# database really is required. From inside a container the host's dev Postgres
# is host.docker.internal.
DEV_DB=${DEV_DATABASE_URL:-postgres://directory:directory@host.docker.internal:5433/directory_dev}
# Database index 5: the dev Redis on 6380 is shared with other work, and nothing
# here may disturb it.
RUNTIME_REDIS=${RUNTIME_REDIS_URL:-redis://host.docker.internal:6380/5}

# `validateEnv`'s RUNTIME_ENV grew BETTER_AUTH_* and the worker boot guard checks
# it, so the worker cannot start without them. Throwaway values on purpose:
# nothing here authenticates anybody, and the check is only that the key is not
# blank — the point is to get past the guard and observe what we came to observe.
AUTH_SECRET=${BETTER_AUTH_SECRET:-verify-image-not-a-real-secret}
AUTH_URL=${BETTER_AUTH_URL:-$SITE_URL}

# What a real deploy passes. $SITE_URL is localhost by default, so
# `validateProductionConfig` waives itself here whatever this is — the two cases
# at the end of this script are what actually exercise the guard, against a
# reachable origin.
SITE_ENV=${SITE_ENV:-production}
# A reachable-looking origin, so `validateProductionConfig` does NOT waive
# itself. `.org` rather than `.example`/`.test`: those are on RESERVED_SUFFIXES
# and would be waived as unreachable, which is exactly the mistake these two
# cases exist to catch.
PUBLIC_SITE_URL=${VERIFY_PUBLIC_SITE_URL:-https://staging.example.org}

# Migrating and seeding get a database of their own, created and dropped here.
# Never $DEV_DB: these steps write, and the dev database is someone's work.
ADMIN_DB=${ADMIN_DATABASE_URL:-postgres://directory:directory@host.docker.internal:5433/postgres}
VERIFY_DB=${VERIFY_DB_NAME:-directory_imgverify}
VERIFY_DB_URL=${ADMIN_DB%/*}/$VERIFY_DB

# A second, separate throwaway database for the MIGRATE_ON_BOOT check below:
# it has to start genuinely unmigrated, which $VERIFY_DB no longer is by the
# time that check runs.
BOOT_DB=${BOOT_DB_NAME:-directory_bootcheck}
BOOT_DB_URL=${ADMIN_DB%/*}/$BOOT_DB

# SITE_ENV is a BUILD arg, not a boot one: `next.config.ts` `headers()` is
# evaluated during the build and frozen into routes-manifest.json, and
# `validateProductionConfig` runs there too. Passed explicitly on every build
# here for the same reason a deploy must pass it — the Dockerfile gives it no
# default, so an omitted arg is a noindex image.
build() {
  docker build --target "$1" \
    --add-host=host.docker.internal:host-gateway \
    --build-arg NEXT_PUBLIC_SITE_URL="$SITE_URL" \
    --build-arg SITE_ENV="$SITE_ENV" \
    -t "$2" .
}

fail() { echo "FAIL: $*" >&2; exit 1; }

# CREATE/DROP DATABASE cannot run inside a transaction and needs a connection to
# some other database, so it goes through the admin URL. Run from inside the
# runner image rather than a host `psql`, which the machine may not have — the
# image already ships `postgres` for the app, and using it also proves the
# client the migration script depends on is genuinely present.
admin_sql() {
  docker run --rm --add-host=host.docker.internal:host-gateway \
    -e ADMIN_URL="$ADMIN_DB" -e STMT="$1" "$IMAGE" \
    node --input-type=module -e '
      import postgres from "postgres";
      const sql = postgres(process.env.ADMIN_URL, { max: 1, onnotice: () => {} });
      await sql.unsafe(process.env.STMT);
      await sql.end();
    ' > /dev/null
}

# One trap for everything, armed before anything is created: a failure halfway
# through must not leave a stray database or volume behind for the next run.
VOL=""
DB_CREATED=""
BOOT_DB_CREATED=""
BOOT_CONTAINER=""
EXTRA_IMAGES=""
cleanup() {
  if [ -n "$BOOT_CONTAINER" ]; then docker rm -f "$BOOT_CONTAINER" > /dev/null 2>&1 || true; fi
  if [ -n "$EXTRA_IMAGES" ]; then docker rmi -f $EXTRA_IMAGES > /dev/null 2>&1 || true; fi
  # `if`, not `&&`: under `set -e` a false test would abort the trap and leave
  # the rest of the cleanup undone.
  if [ -n "$VOL" ]; then docker volume rm -f "$VOL" > /dev/null 2>&1 || true; fi
  if [ -n "$DB_CREATED" ]; then
    admin_sql "drop database if exists \"$VERIFY_DB\" with (force)" 2>/dev/null || true
  fi
  if [ -n "$BOOT_DB_CREATED" ]; then
    admin_sql "drop database if exists \"$BOOT_DB\" with (force)" 2>/dev/null || true
  fi
  return 0
}
trap cleanup EXIT

echo "--- building runner ---"
build runner "$IMAGE"

echo "--- cache handler imports ---"
docker run --rm "$IMAGE" \
  node -e "import('./cache-handler.mjs').then(()=>console.log('ok'))"

echo "--- deploy 1: assets land on an empty volume ---"
VOL=$(docker volume create)
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

# The runner is the image Coolify's pre-deployment command runs in.
echo "--- runner: migrates a fresh database ---"
admin_sql "drop database if exists \"$VERIFY_DB\" with (force)"
admin_sql "create database \"$VERIFY_DB\""
DB_CREATED=1

M_OUT=$(docker run --rm --add-host=host.docker.internal:host-gateway \
  -e DATABASE_URL="$VERIFY_DB_URL" "$IMAGE" node scripts/migrate.mjs 2>&1) \
  || fail "the runner image could not migrate: $M_OUT"
grep -qE "^\[migrate\] applied [1-9][0-9]* migration" <<<"$M_OUT" \
  || fail "migrate.mjs applied nothing to an empty database: $M_OUT"
# Named, not counted: a run that reported a number but listed no tag would mean
# the journal is unreadable in the image, which is how a half-copied drizzle/
# would look.
grep -qE "^\[migrate\]   [0-9]{4}_" <<<"$M_OUT" || fail "no migration was named: $M_OUT"
echo "ok: $(grep -cE '^\[migrate\]   ' <<<"$M_OUT") migrations applied in the runner image"

# Coolify runs the pre-deployment command on EVERY deploy, so the second run is
# the common case, and it has to be a clean no-op rather than an error.
echo "--- runner: migrating again is a no-op ---"
M2_OUT=$(docker run --rm --add-host=host.docker.internal:host-gateway \
  -e DATABASE_URL="$VERIFY_DB_URL" "$IMAGE" node scripts/migrate.mjs 2>&1) \
  || fail "a second migrate run failed: $M2_OUT"
grep -q "already up to date" <<<"$M2_OUT" || fail "second run was not a no-op: $M2_OUT"
echo "ok: already up to date"

# A pre-deployment step that hangs is worse than one that fails: Coolify waits.
echo "--- runner: an unusable database fails the step instead of hanging ---"
set +e
BAD_OUT=$(docker run --rm "$IMAGE" node scripts/migrate.mjs 2>&1)
BAD_CODE=$?
set -e
[ "$BAD_CODE" -ne 0 ] || fail "migrate.mjs exited 0 with no DATABASE_URL"
grep -q "DATABASE_URL is not set" <<<"$BAD_OUT" || fail "no clear message: $BAD_OUT"
echo "ok: exit $BAD_CODE, and it said why"

# The entrypoint check: MIGRATE_ON_BOOT=true has to actually migrate a fresh
# database before the server ever answers a request — not just that
# scripts/migrate.mjs works standalone (already proven above), but that the
# container wires it in ahead of `node server.js`, as the nextjs user, gated
# to the web role.
echo "--- boot: MIGRATE_ON_BOOT=true migrates a fresh database before serving ---"
admin_sql "drop database if exists \"$BOOT_DB\" with (force)"
admin_sql "create database \"$BOOT_DB\""
BOOT_DB_CREATED=1

BOOT_CONTAINER=$(docker run -d --add-host=host.docker.internal:host-gateway \
  -e MIGRATE_ON_BOOT=true \
  -e DATABASE_URL="$BOOT_DB_URL" \
  -e NEXT_PUBLIC_SITE_URL="$SITE_URL" \
  -e REDIS_URL="$RUNTIME_REDIS" \
  -e BETTER_AUTH_SECRET="$AUTH_SECRET" \
  -e BETTER_AUTH_URL="$AUTH_URL" \
  -p 127.0.0.1::3000 "$IMAGE")
BOOT_PORT=$(docker port "$BOOT_CONTAINER" 3000/tcp | head -n1 | cut -d: -f2)

# Poll rather than sleep-and-hope: migrating 8 files then booting Next.js takes
# a variable few seconds, and a container that dies mid-migration must fail
# this loop (not time out looking like a slow success).
ready=""
for _ in $(seq 1 30); do
  if [ "$(docker inspect -f '{{.State.Running}}' "$BOOT_CONTAINER" 2>/dev/null)" != "true" ]; then
    fail "container exited before serving: $(docker logs "$BOOT_CONTAINER" 2>&1 | tail -30)"
  fi
  CODE=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$BOOT_PORT/pricing" 2>/dev/null || echo 000)
  if [ "$CODE" = "200" ]; then ready=1; break; fi
  sleep 1
done
[ -n "$ready" ] || fail "/pricing did not return 200 within 30s of boot: $(docker logs "$BOOT_CONTAINER" 2>&1 | tail -30)"
echo "ok: /pricing returned 200 after boot"

BOOT_LOG=$(docker logs "$BOOT_CONTAINER" 2>&1)
grep -q "MIGRATE_ON_BOOT=true: running scripts/migrate.mjs before serving" <<<"$BOOT_LOG" \
  || fail "entrypoint did not log the pre-migrate line: $BOOT_LOG"
grep -q "migrations applied" <<<"$BOOT_LOG" || fail "entrypoint did not log the post-migrate line: $BOOT_LOG"

ROWS=$(docker run --rm --add-host=host.docker.internal:host-gateway \
  -e ADMIN_URL="$BOOT_DB_URL" "$IMAGE" \
  node --input-type=module -e '
    import postgres from "postgres";
    const sql = postgres(process.env.ADMIN_URL, { max: 1, onnotice: () => {} });
    const rows = await sql`select count(*)::int as n from drizzle.__drizzle_migrations`;
    console.log(rows[0].n);
    await sql.end();
  ')
[ "$ROWS" = "8" ] || fail "expected 8 rows in drizzle.__drizzle_migrations after boot, got $ROWS"
echo "ok: drizzle.__drizzle_migrations has 8 rows"

docker rm -f "$BOOT_CONTAINER" > /dev/null 2>&1 || true
BOOT_CONTAINER=""

echo "--- boot: MIGRATE_ON_BOOT=true with a wrong DATABASE_URL exits non-zero instead of serving ---"
set +e
WRONGBOOT_OUT=$(docker run --rm --add-host=host.docker.internal:host-gateway \
  -e MIGRATE_ON_BOOT=true \
  -e DATABASE_URL="postgres://directory:wrong-password@host.docker.internal:5433/$BOOT_DB" \
  -e NEXT_PUBLIC_SITE_URL="$SITE_URL" \
  -e REDIS_URL="$RUNTIME_REDIS" \
  -e BETTER_AUTH_SECRET="$AUTH_SECRET" \
  -e BETTER_AUTH_URL="$AUTH_URL" \
  "$IMAGE" 2>&1)
WRONGBOOT_CODE=$?
set -e
[ "$WRONGBOOT_CODE" -ne 0 ] || fail "container booted (exit 0) with a wrong DATABASE_URL"
if grep -q "Ready in" <<<"$WRONGBOOT_OUT"; then
  fail "the server started despite a wrong DATABASE_URL: $WRONGBOOT_OUT"
fi
echo "ok: exit $WRONGBOOT_CODE, server never started"

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
  -e DATABASE_URL="$DEV_DB" \
  -e REDIS_URL="$RUNTIME_REDIS" \
  -e BETTER_AUTH_SECRET="$AUTH_SECRET" \
  -e BETTER_AUTH_URL="$AUTH_URL" \
  "$IMAGE-worker" timeout -s TERM 20 ./node_modules/.bin/tsx worker/index.ts 2>&1)
set -e
grep -q "\[worker\] started" <<<"$W_OUT" || fail "worker did not start: $W_OUT"
if grep -qi "cannot find\|ERR_MODULE_NOT_FOUND\|Cannot find package" <<<"$W_OUT"; then
  fail "worker had unresolved imports: $W_OUT"
fi
echo "ok: $(grep -c '^\[worker\]' <<<"$W_OUT") worker startup lines, no unresolved imports"

echo "--- worker: missing env stops the process instead of idling ---"
# DATABASE_URL is set here so `@/lib/db/client` resolves at import time instead
# of throwing before validateEnv gets a chance to run — REDIS_URL is the only
# thing missing, so this exercises validateEnv's own process.exit(1) path. Every
# other RUNTIME_ENV key is supplied for the same reason: a run that failed on
# three missing keys would still exit non-zero and tell us nothing.
set +e
docker run --rm -e WORKER_ENABLED=true -e NEXT_PUBLIC_SITE_URL="$SITE_URL" \
  -e DATABASE_URL="$DEV_DB" \
  -e BETTER_AUTH_SECRET="$AUTH_SECRET" \
  -e BETTER_AUTH_URL="$AUTH_URL" \
  "$IMAGE-worker" ./node_modules/.bin/tsx worker/index.ts > /dev/null 2>&1
E_CODE=$?
set -e
[ "$E_CODE" -ne 0 ] || fail "worker booted with no REDIS_URL"
echo "ok: exit $E_CODE"

# Against the database the RUNNER migrated a moment ago — the real first-deploy
# order, and the only way to catch the two images disagreeing about the schema.
echo "--- worker: seeds the database the runner migrated ---"
S_OUT=$(docker run --rm --add-host=host.docker.internal:host-gateway \
  -e NEXT_PUBLIC_SITE_URL="$SITE_URL" \
  -e DATABASE_URL="$VERIFY_DB_URL" \
  "$IMAGE-worker" ./node_modules/.bin/tsx scripts/seed-cli.ts 2>&1) \
  || fail "the worker image could not seed: $S_OUT"
# No niche argument: the default has to come from siteConfig, or a clone ships a
# seed command naming the niche it was forked from.
grep -qE '^seeded ".+": [1-9][0-9]* cities, [1-9][0-9]* categories, [1-9][0-9]* listings' <<<"$S_OUT" \
  || fail "seed reported nothing inserted: $S_OUT"
echo "ok: $S_OUT"

# Re-seeding is what a redeploy or a nervous operator does. It must skip, not
# duplicate — and skipping proves the first run really committed.
echo "--- worker: re-seeding skips instead of duplicating ---"
S2_OUT=$(docker run --rm --add-host=host.docker.internal:host-gateway \
  -e NEXT_PUBLIC_SITE_URL="$SITE_URL" \
  -e DATABASE_URL="$VERIFY_DB_URL" \
  "$IMAGE-worker" ./node_modules/.bin/tsx scripts/seed-cli.ts 2>&1) \
  || fail "the worker image could not re-seed: $S2_OUT"
grep -qE '^seeded ".+": 0 cities, 0 categories, 0 listings \([1-9][0-9]* skipped' <<<"$S2_OUT" \
  || fail "re-seeding was not idempotent: $S2_OUT"
echo "ok: $S2_OUT"

# SITE_ENV is a build arg — these two cases are the only thing that keeps it
# one. Both build the `builder` stage only: what is under test is `next build`
# and the config guards it runs, not the runner's layers.
echo "--- staging build: a real subdomain with SITE_ENV=staging builds ---"
EXTRA_IMAGES="$IMAGE-staging-builder"
set +e
SB_OUT=$(docker build --target builder \
  --add-host=host.docker.internal:host-gateway \
  --build-arg NEXT_PUBLIC_SITE_URL="$PUBLIC_SITE_URL" \
  --build-arg SITE_ENV=staging \
  -t "$IMAGE-staging-builder" . 2>&1)
SB_CODE=$?
set -e
[ "$SB_CODE" -eq 0 ] \
  || fail "a staging image on a real subdomain could not be built — SITE_ENV is not reaching next build: $(tail -40 <<<"$SB_OUT")"
echo "ok: SITE_ENV=staging reaches the builder and waives the production config guard"

# The other half: without it the guard must fire, or "SITE_ENV is a build arg"
# is a claim about a variable nothing reads.
echo "--- no SITE_ENV: the placeholder guard fails the build ---"
set +e
NB_OUT=$(docker build --target builder \
  --add-host=host.docker.internal:host-gateway \
  --build-arg NEXT_PUBLIC_SITE_URL="$PUBLIC_SITE_URL" \
  -t "$IMAGE-noenv-builder" . 2>&1)
NB_CODE=$?
set -e
EXTRA_IMAGES="$EXTRA_IMAGES $IMAGE-noenv-builder"
[ "$NB_CODE" -ne 0 ] || fail "the build succeeded on a reachable origin with placeholder config"
grep -q "is not ready for production" <<<"$NB_OUT" \
  || fail "the build failed for some other reason than the placeholder guard: $(tail -40 <<<"$NB_OUT")"
grep -q "legalEntity is still" <<<"$NB_OUT" \
  || fail "no placeholder was named: $(tail -40 <<<"$NB_OUT")"
echo "ok: exit $NB_CODE, and it named the placeholder"

echo "PASS: cache handler loads, assets survive a redeploy, a read-only volume"
echo "      fails the boot, the worker runs its real entrypoint, the runner"
echo "      migrates a fresh database and the worker seeds it, MIGRATE_ON_BOOT"
echo "      migrates before serving and refuses to boot on a bad DATABASE_URL,"
echo "      and SITE_ENV is genuinely a build arg — staging builds, and its"
echo "      absence is caught."
