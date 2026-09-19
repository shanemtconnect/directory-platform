import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/lib/db/schema";
import { runSeed, DEFAULT_NICHE } from "./seed";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");
// Derived from siteConfig.entity, not written down: a clone that hard-codes a
// niche here ships a directory whose seed command still names the old one.
const niche = process.argv[2] ?? DEFAULT_NICHE;

const client = postgres(url, { max: 1 });
const db = drizzle(client, { schema });

const report = await runSeed(db as never, niche);
console.log(
  `seeded "${niche}": ${report.cities} cities, ${report.categories} categories, ` +
    `${report.listings} listings (${report.skipped} skipped as already present)`,
);
await client.end();
