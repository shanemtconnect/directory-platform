#!/usr/bin/env bash
#
# Proves the product: answer the questions, get a directory.
#
# Everything else in this repo checks the demo niche. This takes a clean copy
# of HEAD, turns it into a SECOND directory — a different niche, country,
# currency and set of nouns, from docs/examples/answers.example.json — and then
# does to that clone everything a real one has to survive before launch:
#
#   1. git archive HEAD into a scratch directory, dependencies installed from
#      the lockfile (Turbopack refuses a node_modules symlink that points
#      outside the project, and a real clone installs anyway).
#   2. `pnpm new-site --answers …` non-interactively, first run, no flags.
#   3. Its own throwaway database, migrated, seeded from the CSVs the wizard
#      copied in. NEVER the dev, test or e2e database.
#   4. `pnpm typecheck`, `pnpm check:strings`, a production build
#      (SITE_ENV=production, the generated .env underneath).
#   5. The standalone server the Dockerfile ships, on its own port and its own
#      Redis database index. Home, a city, a listing, the sitemap and
#      robots.txt answer 200 — and none of them mentions the demo niche.
#   6. The whole Playwright suite against it.
#
# Every failure here is a bug in the platform, not in this script: a config
# block the writer forgot, a seed column the loader reads but the wizard does
# not know about, a spec that hardcodes a town from the demo seed. Fix it in
# the tree and re-run.
#
#   bash scripts/verify-clone.sh           # run, then tear everything down
#   bash scripts/verify-clone.sh --keep    # leave the clone and its database
#
# Idempotent: the scratch directory and the database are recreated each run.
# Foreground only — the server is a child of this script and dies with it.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)

KEEP=0
for arg in "$@"; do
  case "$arg" in
    --keep) KEEP=1 ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "Unknown argument: $arg (expected --keep)" >&2; exit 2 ;;
  esac
done

# --- knobs -------------------------------------------------------------------
# Every port, index and name is one no other worker on this machine uses: the
# dev stack is 3200/db 0, verify-isr is 3101/db 9, verify-image is db 5.
PROOF_DIR=${CLONE_PROOF_DIR:-${CLAUDE_SCRATCHPAD:-${TMPDIR:-/tmp}}/clone-proof}
CLONE_DIR="$PROOF_DIR/site"
ANSWERS=${CLONE_ANSWERS:-docs/examples/answers.example.json}
PORT=${CLONE_PORT:-3240}
SITE_URL="http://localhost:$PORT"

DB_NAME=${CLONE_DB_NAME:-directory_clone}
DB_USER=${DB_USER:-directory}
DB_PASSWORD=${DB_PASSWORD:-directory}
DB_HOST=${DB_HOST:-localhost}
DB_PORT=${DB_PORT:-5433}
CONTAINER=${POSTGRES_CONTAINER:-directory-platform-postgres-1}
DB_URL="postgres://${DB_USER}:${DB_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_NAME}"

REDIS_URL=${CLONE_REDIS_URL:-redis://localhost:6380/6}
REDIS_CONTAINER=${REDIS_CONTAINER:-directory-platform-redis-1}

# The three databases this script must never touch, whatever DB_NAME says.
case "$DB_NAME" in
  directory_dev|directory_test|directory_e2e)
    echo "Refusing to use $DB_NAME — it belongs to someone else. Set CLONE_DB_NAME." >&2; exit 1 ;;
esac
RDB=${REDIS_URL##*/}
case "$RDB" in
  ''|*[!0-9]*) echo "CLONE_REDIS_URL must end in a database index, e.g. redis://localhost:6380/6" >&2; exit 1 ;;
  0) echo "Refusing Redis db 0: it holds the dev ISR cache." >&2; exit 1 ;;
esac

# --- plumbing ----------------------------------------------------------------
STEP_NAMES=()
STEP_SECS=()
STEP_STATUS=()
CURRENT=""
CURRENT_START=0
SCRIPT_START=$(date +%s)

begin() {
  CURRENT="$1"
  CURRENT_START=$(date +%s)
  echo
  echo "=== $1 ==="
}
finish() {
  local secs=$(( $(date +%s) - CURRENT_START ))
  STEP_NAMES+=("$CURRENT"); STEP_SECS+=("$secs"); STEP_STATUS+=("${1:-ok}")
  echo "--- $CURRENT: ${1:-ok} (${secs}s)"
  CURRENT=""
}
fail() {
  echo "FAIL: $*" >&2
  if [ -n "$CURRENT" ]; then finish FAIL; fi
  exit 1
}
summary() {
  local total=$(( $(date +%s) - SCRIPT_START ))
  echo
  printf '%-34s %8s  %s\n' "step" "seconds" "result"
  printf '%-34s %8s  %s\n' "----" "-------" "------"
  local i
  for i in "${!STEP_NAMES[@]}"; do
    printf '%-34s %8s  %s\n' "${STEP_NAMES[$i]}" "${STEP_SECS[$i]}" "${STEP_STATUS[$i]}"
  done
  printf '%-34s %8s\n' "total" "$total"
}

psql_admin() {
  docker exec -i "$CONTAINER" psql -U "$DB_USER" -d postgres -v ON_ERROR_STOP=1 -qc "$1"
}
psql_clone() {
  docker exec -i "$CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 -tAc "$1"
}

SERVER_PID=""
DB_CREATED=""
cleanup() {
  local code=$?
  if [ -n "$SERVER_PID" ]; then kill "$SERVER_PID" 2>/dev/null || true; wait "$SERVER_PID" 2>/dev/null || true; fi
  # The server's ISR cache lives in this Redis index; leave it as it was found.
  # (The keep case keeps the directory and the database, not the cache — a
  # kept clone booted again starts cold, which is what a redeploy does.)
  docker exec "$REDIS_CONTAINER" redis-cli -n "$RDB" flushdb >/dev/null 2>&1 || true
  # A failed run keeps its logs whatever --keep says: the point of a proof
  # that fails is to read why, and the directory is what holds the answer.
  if [ "$code" -ne 0 ] && [ "$KEEP" != "1" ]; then
    echo
    echo "failed (exit $code): logs kept under $PROOF_DIR (build.log, server.log, e2e.log)"
    KEEP=1
  fi
  if [ "$KEEP" = "1" ]; then
    echo
    echo "kept: $CLONE_DIR and database $DB_NAME"
  else
    if [ -n "$DB_CREATED" ]; then psql_admin "drop database if exists ${DB_NAME} with (force)" >/dev/null 2>&1 || true; fi
    rm -rf "$PROOF_DIR"
  fi
  summary
  return $code
}
trap cleanup EXIT

# The banned demo-niche words, taken from the string check itself so the two
# cannot disagree. Rendered HTML of the clone must contain none of them.
DEMO_WORDS=$(sed -nE "s/^BANNED='([^']+)'.*/\1/p" scripts/check-niche-strings.sh)
[ -n "$DEMO_WORDS" ] || fail "could not read BANNED from scripts/check-niche-strings.sh"

# --- 1. a clean copy of HEAD -------------------------------------------------
begin "archive HEAD into a clean directory"
rm -rf "$PROOF_DIR"
mkdir -p "$CLONE_DIR"
# HEAD, not the working tree: the proof is of what is committed. Anything
# uncommitted that the clone needs is a failure this step is meant to produce.
git archive --format=tar HEAD | tar -x -C "$CLONE_DIR"
[ -f "$CLONE_DIR/$ANSWERS" ] || fail "no answers file at $ANSWERS in HEAD"
echo "    $CLONE_DIR"
finish

cd "$CLONE_DIR"

begin "pnpm install --frozen-lockfile"
# From the pnpm store, so this is seconds, not minutes — and it is what a
# clone does on day one. `--offline` first so a run never depends on the
# network; a store that lacks something falls back to a normal install.
corepack pnpm install --frozen-lockfile --offline > "$PROOF_DIR/install.log" 2>&1 \
  || corepack pnpm install --frozen-lockfile > "$PROOF_DIR/install.log" 2>&1 \
  || fail "install: $(tail -20 "$PROOF_DIR/install.log")"
finish

# --- 2. the wizard, non-interactively ----------------------------------------
begin "pnpm new-site --answers"
# First run on a fresh checkout, no --overwrite: that is the documented path
# and the one every clone takes. Silent stdin, so a question that slipped past
# the answers file fails here instead of hanging.
corepack pnpm new-site --answers "$ANSWERS" --target . < /dev/null 2>&1 | tee "$PROOF_DIR/new-site.log" \
  || fail "the wizard refused the answers file"
[ -f config/site.config.ts ] || fail "no config/site.config.ts was written"
[ -f .env ] || fail "no .env was written"
NICHE=$(node -e 'const a=require("./'"$ANSWERS"'");process.stdout.write(a.niche)')
[ -n "$NICHE" ] || fail "answers file names no niche"
for f in cities categories listings; do
  [ -s "seeds/$NICHE/$f.csv" ] || fail "seeds/$NICHE/$f.csv was not written"
done
if grep -qi "ignores the column" "$PROOF_DIR/new-site.log"; then
  fail "the wizard warned that the loader ignores a column the example CSVs use: $(grep -i 'ignores the column' "$PROOF_DIR/new-site.log")"
fi
# The demo config and its seed set must not survive into the clone's output —
# the wizard replaced one and the other is simply not this site's.
# Whole words (-w): a longer word that merely contains a banned one must pass.
if grep -qiwE "$DEMO_WORDS" config/site.config.ts; then
  fail "config/site.config.ts still names the demo niche: $(grep -inwE "$DEMO_WORDS" config/site.config.ts | head -3)"
fi
if [ -d content/blog/demo ]; then fail "the wizard left the demo blog posts in place"; fi
finish

# --- 3. its own database -----------------------------------------------------
begin "create + migrate $DB_NAME"
psql_admin "drop database if exists ${DB_NAME} with (force)" >/dev/null
psql_admin "create database ${DB_NAME}" >/dev/null
DB_CREATED=1
DATABASE_URL="$DB_URL" corepack pnpm db:migrate 2>&1 | tail -3 || fail "migrating $DB_NAME failed"
MIGRATIONS=$(psql_clone "select count(*) from drizzle.__drizzle_migrations")
EXPECTED=$(grep -c '"idx"' drizzle/meta/_journal.json)
[ "$MIGRATIONS" = "$EXPECTED" ] || fail "expected $EXPECTED migrations applied, got $MIGRATIONS"
echo "    $MIGRATIONS migrations"
finish

begin "seed from the scaffolded CSVs"
# No niche argument: the default has to come from the CLONE's siteConfig.
SEED_OUT=$(DATABASE_URL="$DB_URL" corepack pnpm seed 2>&1) || fail "seed failed: $SEED_OUT"
echo "    $SEED_OUT"
grep -qE "^seeded \"$NICHE\": [1-9][0-9]* cities, [1-9][0-9]* categories, [1-9][0-9]* listings" <<<"$SEED_OUT" \
  || fail "the seed did not load the clone's niche: $SEED_OUT"
EXPECTED_LISTINGS=$(( $(wc -l < "seeds/$NICHE/listings.csv") - 1 ))
SEEDED=$(psql_clone "select count(*) from listings where status = 'published'")
[ "$SEEDED" = "$EXPECTED_LISTINGS" ] || fail "listings.csv has $EXPECTED_LISTINGS rows but $SEEDED were published — rows were skipped"
INDEXABLE=$(psql_clone "select count(*) from cities where is_indexable")
[ "$INDEXABLE" -gt 0 ] || fail "no city is indexable after the seed — the gate or the intro copy is broken"
echo "    $SEEDED listings, $INDEXABLE indexable cities"
finish

# --- 4. the static gates -----------------------------------------------------
begin "pnpm typecheck"
corepack pnpm typecheck > "$PROOF_DIR/typecheck.log" 2>&1 || fail "typecheck: $(tail -20 "$PROOF_DIR/typecheck.log")"
finish

begin "pnpm check:strings"
corepack pnpm check:strings 2>&1 | tail -3 || fail "check:strings"
finish

# What a deploy passes. SITE_ENV=production so the noindex header is NOT
# frozen into the build, and the same origin the server will be booted on so
# canonicals and the sitemap agree with what the suite asks for.
BUILD_ENV=(
  NEXT_PUBLIC_SITE_URL="$SITE_URL"
  SITE_ENV=production
  DATABASE_URL="$DB_URL"
  REDIS_URL="$REDIS_URL"
)
begin "pnpm build (SITE_ENV=production)"
env "${BUILD_ENV[@]}" corepack pnpm build > "$PROOF_DIR/build.log" 2>&1 || fail "build: $(tail -40 "$PROOF_DIR/build.log")"
[ -f .next/standalone/server.js ] || fail "no standalone server was produced"
finish

# --- 5. the server the image ships -------------------------------------------
begin "boot standalone on :$PORT"
docker exec "$REDIS_CONTAINER" redis-cli -n "$RDB" flushdb >/dev/null 2>&1 || true
rm -rf .next/standalone/.next/static .next/standalone/public
cp -R .next/static .next/standalone/.next/static
if [ -d public ]; then cp -R public .next/standalone/public; fi
# The same variables playwright.config.ts gives its own server, so the suite
# reuses this one rather than building a second time.
env "${BUILD_ENV[@]}" \
  PORT="$PORT" HOSTNAME=127.0.0.1 \
  BETTER_AUTH_SECRET=verify-clone-not-a-real-secret \
  BETTER_AUTH_URL="$SITE_URL" \
  BETTER_AUTH_RATE_LIMIT=off \
  TURNSTILE_SITE_KEY=1x00000000000000000000AA \
  TURNSTILE_SECRET_KEY=1x0000000000000000000000000000000AA \
  E2E_IMPORT_FIXTURE=1 \
  node .next/standalone/server.js > "$PROOF_DIR/server.log" 2>&1 &
SERVER_PID=$!
ready=""
for _ in $(seq 1 60); do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then fail "the server exited: $(tail -30 "$PROOF_DIR/server.log")"; fi
  if [ "$(curl -s -o /dev/null -w '%{http_code}' "$SITE_URL/api/health" 2>/dev/null || echo 000)" = "200" ]; then ready=1; break; fi
  sleep 1
done
[ -n "$ready" ] || fail "/api/health did not answer 200 within 60s: $(tail -30 "$PROOF_DIR/server.log")"
finish

begin "curl home / city / listing / sitemap / robots"
CITY_SLUG=$(psql_clone "select slug from cities where is_indexable order by listing_count desc, slug limit 1")
[ -n "$CITY_SLUG" ] || fail "no indexable city to request"
LISTING_PATH=$(psql_clone "select '/' || c.slug || '/' || l.slug from listings l join cities c on c.id = l.city_id where l.status = 'published' and c.slug = '$CITY_SLUG' order by l.slug limit 1")
[ -n "$LISTING_PATH" ] || fail "no published listing in /$CITY_SLUG"
SITE_NAME=$(node -e 'const a=require("./'"$ANSWERS"'");process.stdout.write(a.name)')

check_page() { # path, then a grep pattern the body must contain
  local path=$1 want=$2 body code
  body=$(curl -s -D "$PROOF_DIR/headers.txt" "$SITE_URL$path")
  code=$(sed -n '1s/.* \([0-9][0-9][0-9]\).*/\1/p' "$PROOF_DIR/headers.txt")
  [ "$code" = "200" ] || fail "$path returned $code"
  grep -q "$want" <<<"$body" || fail "$path does not contain '$want'"
  if grep -qi "x-robots-tag: noindex" "$PROOF_DIR/headers.txt"; then
    fail "$path carries X-Robots-Tag: noindex on a SITE_ENV=production build"
  fi
  # Whole words, case-insensitive: a longer word containing a banned one is fine.
  if grep -qiwE "$DEMO_WORDS" <<<"$body"; then
    fail "$path mentions the demo niche: $(grep -oiwE "$DEMO_WORDS" <<<"$body" | sort | uniq -c | head -3)"
  fi
  echo "    200 $path"
}
check_page "/" "$SITE_NAME"
check_page "/$CITY_SLUG" "<h1"
check_page "$LISTING_PATH" "enquiry-form"
check_page "/sitemap.xml" "<sitemapindex"
ROBOTS=$(curl -s "$SITE_URL/robots.txt")
grep -q "Sitemap: $SITE_URL/sitemap.xml" <<<"$ROBOTS" || fail "robots.txt does not point at $SITE_URL/sitemap.xml: $ROBOTS"
if grep -q "Disallow: /$" <<<"$ROBOTS"; then fail "robots.txt disallows everything — SITE_ENV did not reach the server"; fi
echo "    200 /robots.txt"
# The sitemap must actually advertise the clone's city, or the index is empty
# and the suite's sitemap spec would be testing a shell.
# Fetched into a variable first: `grep -q` at the end of a pipeline exits on
# the first match, the still-running curls get SIGPIPE, and under pipefail the
# whole pipeline reports failure for a sitemap that was fine.
SHARDS=$(curl -s "$SITE_URL/sitemap.xml" | grep -oE '<loc>[^<]+' | sed 's/<loc>//')
SHARD_BODIES=""
for shard in $SHARDS; do SHARD_BODIES+=$(curl -s "$shard"); done
grep -q "/$CITY_SLUG<" <<<"$SHARD_BODIES" || fail "no sitemap shard lists /$CITY_SLUG"
echo "    sitemap lists /$CITY_SLUG"
finish

# --- 6. the suite ------------------------------------------------------------
begin "playwright e2e against the clone"
# Throwaway storage values: the photo suite's client flow is intercepted by
# Playwright and never reaches a bucket, but the page only renders the upload
# form when storage looks configured.
E2E_PORT="$PORT" DATABASE_URL="$DB_URL" REDIS_URL="$REDIS_URL" SITE_ENV=production \
  R2_ACCOUNT_ID=e2e-account R2_ACCESS_KEY_ID=e2e-not-a-real-key \
  R2_SECRET_ACCESS_KEY=e2e-not-a-real-secret R2_BUCKET_MEDIA=e2e-media \
  corepack pnpm test:e2e 2>&1 | tee "$PROOF_DIR/e2e.log" | tail -25 \
  || fail "the Playwright suite failed against the clone — see $PROOF_DIR/e2e.log"
grep -qE "[1-9][0-9]* passed" "$PROOF_DIR/e2e.log" || fail "the suite reported no passing tests"
finish

echo
echo "PASS: a second directory — \"$SITE_NAME\" ($NICHE) — was generated from"
echo "      $ANSWERS, migrated, seeded, type-checked, string-checked, built"
echo "      for production, booted as the standalone image entrypoint, served"
echo "      its pages with nothing from the demo niche in them, and passed the"
echo "      whole Playwright suite."
