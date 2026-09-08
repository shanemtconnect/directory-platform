#!/usr/bin/env bash
#
# Drops and rebuilds the local development database from the seed CSVs.
#
# The seed is idempotent, so `pnpm seed` on an existing database adds nothing —
# which is exactly wrong after the seed data itself changes. Rows already there
# keep their old city, their old description and their old intro copy, and the
# database quietly disagrees with the CSVs it was built from. The only honest
# way to pick up a seed change is to start again.
#
# DESTRUCTIVE. Development only, and never against a shared database while
# anyone else is using it.
#
#   bash scripts/reseed-dev.sh
#
set -euo pipefail

DB_NAME="${DB_NAME:-directory_dev}"
DB_USER="${DB_USER:-directory}"
DB_PASSWORD="${DB_PASSWORD:-directory}"
DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5433}"
CONTAINER="${POSTGRES_CONTAINER:-directory-platform-postgres-1}"

if [ "$DB_NAME" = "directory_test" ]; then
  echo "Refusing to drop directory_test — the test harness owns it." >&2
  exit 1
fi

URL="postgres://${DB_USER}:${DB_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_NAME}"

# psql inside the compose container, so this works with no local client.
psql_admin() {
  docker exec -i "$CONTAINER" psql -U "$DB_USER" -d postgres -v ON_ERROR_STOP=1 -c "$1"
}

echo "==> dropping and recreating ${DB_NAME}"
psql_admin "drop database if exists ${DB_NAME} with (force)"
psql_admin "create database ${DB_NAME}"

echo "==> migrating"
DATABASE_URL="$URL" corepack pnpm db:migrate

echo "==> seeding"
DATABASE_URL="$URL" corepack pnpm seed

echo "==> done: ${DB_NAME} rebuilt from seeds/"
