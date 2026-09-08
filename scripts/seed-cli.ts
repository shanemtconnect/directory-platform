import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/lib/db/schema";
import { runSeed } from "./seed";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");
const niche = process.argv[2] ?? "wedding-venues";

const client = postgres(url, { max: 1 });
const db = drizzle(client, { schema });

const report = await runSeed(db as never, niche);
console.log(
  `seeded "${niche}": ${report.cities} cities, ${report.categories} categories, ` +
    `${report.listings} listings (${report.skipped} skipped as already present)`,
);
await client.end();
