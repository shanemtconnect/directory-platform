#!/usr/bin/env bash
#
# Builds the database the Playwright suite runs against.
#
# The e2e suite WRITES. e2e/location.spec.ts submits a listing through the real
# form, which creates a city, a slug-registry row, a listing and audit rows —
# that is the behaviour under test, and mocking it would prove nothing. Pointed
# at `directory_dev` it would quietly scribble on the database everyone else is
# developing against, so the suite has its own: `directory_e2e`, built from the
# same seeds and disposable.
#
#   bash scripts/e2e-db.sh            # create if missing, migrate, seed
#   bash scripts/e2e-db.sh --reset    # drop it first and start again
#
# Creating is idempotent, and so is the seed, so the plain form is safe to run
# before every suite. `--reset` is for when the seed data itself has changed, or
# when a failed run left rows behind that the spec's own cleanup did not remove.
#
set -euo pipefail

DB_NAME="${DB_NAME:-directory_e2e}"
DB_USER="${DB_USER:-directory}"
DB_PASSWORD="${DB_PASSWORD:-directory}"
DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5433}"
CONTAINER="${POSTGRES_CONTAINER:-directory-platform-postgres-1}"

RESET=0
for arg in "$@"; do
  case "$arg" in
    --reset) RESET=1 ;;
    *) echo "Unknown argument: $arg (expected --reset)" >&2; exit 2 ;;
  esac
done

# The two databases this script must never touch, whatever DB_NAME says: the
# unit harness owns one and a person's own work lives in the other.
case "$DB_NAME" in
  directory_test) echo "Refusing to touch directory_test — the unit harness owns it." >&2; exit 1 ;;
  directory_dev)  echo "Refusing to touch directory_dev — that is your working database." >&2; exit 1 ;;
esac

URL="postgres://${DB_USER}:${DB_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_NAME}"

# psql inside the compose container, so this works with no local client — the
# same approach as scripts/reseed-dev.sh.
psql_admin() {
  docker exec -i "$CONTAINER" psql -U "$DB_USER" -d postgres -v ON_ERROR_STOP=1 -c "$1"
}

if [ "$RESET" = "1" ]; then
  echo "==> dropping ${DB_NAME}"
  psql_admin "drop database if exists ${DB_NAME} with (force)"
fi

echo "==> creating ${DB_NAME} if it does not exist"
# `create database` has no IF NOT EXISTS, and a second run must not fail the
# script, so the existence check is the gate.
exists=$(docker exec -i "$CONTAINER" psql -U "$DB_USER" -d postgres -tAc \
  "select 1 from pg_database where datname = '${DB_NAME}'")
if [ "$exists" != "1" ]; then
  psql_admin "create database ${DB_NAME}"
else
  echo "    already there"
fi

echo "==> migrating"
DATABASE_URL="$URL" corepack pnpm db:migrate

echo "==> seeding"
DATABASE_URL="$URL" corepack pnpm seed

echo "==> done: ${DB_NAME} ready at ${URL}"
