#!/usr/bin/env node
/**
 * Production migration runner.
 *
 * `drizzle-kit migrate` is a devDependency and the runner image ships prod deps
 * only, so the deploy cannot shell out to it — but the deploy is exactly where
 * migrating has to happen. A container that starts ahead of its own migration
 * serves a site whose every enquiry fails: `createSubmission` inserts into
 * `job_queue` inside its transaction, so a missing column takes the form down,
 * not just the worker.
 *
 * Plain ESM on purpose. No tsx, no ts-node, no build step — the two packages it
 * imports (`drizzle-orm`, `postgres`) are runtime dependencies that the runner
 * already carries for the app itself.
 *
 * The applied set is identical to `drizzle-kit migrate`'s: both call the same
 * `migrate()` from `drizzle-orm/postgres-js/migrator` over the same `drizzle/`
 * folder, and the rows it writes to `drizzle.__drizzle_migrations` carry the
 * same sha256-of-file hashes. See `docs/` — and the parity check in the task
 * report — for the two-database comparison that proves it.
 *
 *   DATABASE_URL=postgres://… node scripts/migrate.mjs
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const MIGRATIONS_FOLDER = "./drizzle";

function die(message, error) {
  console.error(`[migrate] FAILED: ${message}`);
  if (error) console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
}

const url = process.env.DATABASE_URL;
if (!url) die("DATABASE_URL is not set. Nothing to migrate against.");

/**
 * hash → tag, computed the way the migrator computes it: sha256 over the raw
 * text of each `.sql` file named in the journal. Only used to name what was
 * applied; a journal we cannot read costs the report, not the migration.
 */
function tagsByHash() {
  const map = new Map();
  try {
    const journal = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8"));
    for (const entry of journal.entries ?? []) {
      const sql = readFileSync(join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), "utf8");
      map.set(createHash("sha256").update(sql).digest("hex"), entry.tag);
    }
  } catch {
    // Reported as bare hashes below.
  }
  return map;
}

/** [] on a database that has never been migrated — the table does not exist yet. */
async function appliedHashes(client) {
  try {
    const rows = await client.unsafe(
      "select hash from drizzle.__drizzle_migrations order by created_at, id",
    );
    return rows.map((row) => row.hash);
  } catch {
    return [];
  }
}

// `max: 1` — one connection, so the statements in a migration file run in the
// order they were written rather than racing across a pool. `onnotice` collapses
// postgres.js's default multi-line NOTICE dump ("schema \"drizzle\" already
// exists, skipping" on every redeploy) to one line, so a real message is still
// visible but the deploy log is readable.
const client = postgres(url, {
  max: 1,
  onnotice: (notice) => console.log(`[migrate] notice: ${notice.message}`),
});

try {
  const names = tagsByHash();
  const before = new Set(await appliedHashes(client));

  await migrate(drizzle(client), { migrationsFolder: MIGRATIONS_FOLDER });

  const after = await appliedHashes(client);
  const fresh = after.filter((hash) => !before.has(hash));

  if (fresh.length === 0) {
    console.log(`[migrate] already up to date (${after.length} migrations applied)`);
  } else {
    console.log(`[migrate] applied ${fresh.length} migration(s):`);
    for (const hash of fresh) console.log(`[migrate]   ${names.get(hash) ?? hash}`);
    console.log(`[migrate] ok — ${after.length} migrations applied in total`);
  }
} catch (error) {
  // The connection is closed in `finally`; without it a failure here hangs the
  // pre-deployment step instead of failing it, and Coolify waits forever.
  die("migration did not complete. The database is unchanged past the last committed statement.", error);
} finally {
  await client.end({ timeout: 5 });
}
