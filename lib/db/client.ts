import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export type Db = PostgresJsDatabase<typeof schema>;

/**
 * The connection is opened on FIRST USE, not on import.
 *
 * This module used to read `DATABASE_URL` and throw at import time, which made
 * merely importing it — as every page, route handler and query module does —
 * require a reachable database. `next build` imports each route's module to
 * read its `metadata` and `revalidate` exports, so a build with no database
 * died before it rendered anything, and the Docker builder stage had to be
 * handed a live DATABASE_URL as a build arg.
 *
 * Deferring the read changes when the failure happens, not whether: an unset
 * DATABASE_URL still throws the same error the moment anything queries, and
 * `instrumentation.ts` still refuses to boot a server without one (see
 * RUNTIME_ENV in config/validate.ts). What it buys is a build that only needs a
 * database for the pages that actually read one.
 */
let connection: Db | null = null;

function connect(): Db {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not set");
  // max: 10 per site container. Ten sites on one Postgres is 100 connections —
  // keep this in step with the server's max_connections.
  return drizzle(postgres(connectionString, { max: 10 }), { schema });
}

/** The pool, opened on demand. Callers that can name their own access point use this. */
export function getDb(): Db {
  connection ??= connect();
  return connection;
}

/**
 * `db` stays a value rather than becoming `getDb()` at ~40 call sites: a Proxy
 * forwards every property to the real handle the first time one is read.
 * Methods are bound to the real database, so `this` inside drizzle is never the
 * proxy.
 */
export const db: Db = new Proxy({} as Db, {
  get(_target, property) {
    const real = getDb();
    const value = Reflect.get(real, property, real);
    return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(real) : value;
  },
  has(_target, property) {
    return Reflect.has(getDb(), property);
  },
});
