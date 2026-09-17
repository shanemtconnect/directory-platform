import { writeFileSync } from "node:fs";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/lib/db/schema";
import { parseOutreachArgs, OUTREACH_USAGE } from "@/lib/outreach/args";
import { buildOutreachBatch } from "@/lib/outreach/batch";
import { describeSegment } from "@/lib/outreach/segment";
import { outreachCsv } from "@/lib/outreach/csv";
import type { Viewer } from "@/lib/db/viewer";
import type { Db } from "@/lib/db/client";

/**
 * Builds one claim-outreach batch and writes the CSV.
 *
 *   tsx scripts/outreach-batch.ts --segment city=leeds --limit 50 --coupon-percent 50
 *
 * Everything happens in ONE transaction. A batch is a campaign row, a message
 * per recipient and a coupon per recipient, and a half-written one is the
 * worst possible outcome: tokens nobody was sent, or a file whose codes do not
 * exist. It commits together or not at all — and `--dry-run` rolls it back
 * deliberately so the file can be inspected before anything is recorded.
 *
 * The CSV goes to stdout unless `--out` is given, so it pipes; the summary
 * goes to stderr so the pipe stays clean.
 */

/**
 * The operator, running with a shell and DATABASE_URL. There is no session
 * here to derive a viewer from, and every query function takes one. The id is
 * the nil UUID: real enough that a comparison cannot break, and it can never
 * match a row's owner_id.
 */
const CLI_VIEWER: Viewer = { role: "admin", userId: "00000000-0000-0000-0000-000000000000" };

class Rollback extends Error {}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error(`DATABASE_URL is not set\n\n${OUTREACH_USAGE}`);
  process.exit(1);
}

let args;
try {
  args = parseOutreachArgs(process.argv.slice(2));
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}

const client = postgres(url, { max: 1 });
const database = drizzle(client, { schema });

let csv = "";
let summary = "";
try {
  await database
    .transaction(async (tx) => {
      const batch = await buildOutreachBatch(tx as unknown as Db, CLI_VIEWER, {
        segment: args.segment,
        limit: args.limit,
        couponPercent: args.couponPercent,
        name: args.name ?? undefined,
        // Null when --actor was not given. Nobody is invented: an audit row
        // with a made-up actor is worse than one that says "a shell".
        actorProfileId: args.actorProfileId,
      });
      csv = outreachCsv(batch.rows);
      summary =
        `${batch.rows.length} listing(s) in segment "${describeSegment(args.segment)}"` +
        (batch.campaignId === null
          ? " — nothing written"
          : `, campaign ${batch.campaignId}, coupon batch ${batch.batchId}`);
      if (args.dryRun) throw new Rollback();
    })
    .catch((e: unknown) => {
      if (!(e instanceof Rollback)) throw e;
    });
} finally {
  await client.end({ timeout: 5 });
}

if (args.out === null) process.stdout.write(csv);
else writeFileSync(args.out, csv, "utf8");

console.error(
  `${args.dryRun ? "[dry run, rolled back] " : ""}${summary}` +
    (args.out === null ? "" : `\nwrote ${args.out}`),
);
