import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is not set");

// max: 10 per site container. Ten sites on one Postgres is 100 connections —
// keep this in step with the server's max_connections.
const client = postgres(connectionString, { max: 10 });

export const db = drizzle(client, { schema });
export type Db = typeof db;
