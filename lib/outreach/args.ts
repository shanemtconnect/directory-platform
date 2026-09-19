import { parseSegment, type Segment } from "./segment";

/**
 * The batch CLI's arguments.
 *
 * Split out of the script so the parsing is testable without a database, and
 * strict on purpose: this command produces a list of people to email, so an
 * unrecognised flag is an error rather than something quietly ignored.
 */

export interface OutreachArgs {
  segment: Segment;
  limit: number;
  couponPercent: number;
  /** File to write the CSV to. Null means stdout. */
  out: string | null;
  name: string | null;
  /**
   * `profiles.id` of the operator running this. Recorded on the audit row and
   * on every coupon's `created_by`, so a batch has a name against it.
   */
  actorProfileId: string | null;
  /** Build the batch, print the CSV, roll it all back. */
  dryRun: boolean;
}

export const DEFAULT_LIMIT = 50;

/**
 * One run cannot exceed this. A mistyped `--limit 50000` against a seeded
 * database is fifty thousand addresses in a file, and the mistake is only
 * visible after the file exists.
 */
export const MAX_LIMIT = 1000;

export const OUTREACH_USAGE = [
  "Usage: tsx scripts/outreach-batch.ts --coupon-percent 50 [options]",
  "",
  "  --segment key=value   city=<slug> and/or category=<slug>. Repeatable.",
  `  --limit N             How many listings (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`,
  "  --coupon-percent N    Discount on the single-use codes. Required.",
  "  --name NAME           Campaign name (default: the segment and today's date).",
  "  --actor UUID          profiles.id of whoever is running this. Recorded on",
  "                        the audit row and on every coupon.",
  "  --out FILE            Write the CSV here (default: stdout).",
  "  --dry-run             Build it, print the CSV, roll the whole thing back.",
].join("\n");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function integer(label: string, raw: string): number {
  if (!/^-?\d+$/.test(raw.trim())) throw new Error(`--${label} must be a whole number, got "${raw}"`);
  return Number.parseInt(raw, 10);
}

export function parseOutreachArgs(argv: readonly string[]): OutreachArgs {
  const segments: string[] = [];
  let limit: number | null = null;
  let couponPercent: number | null = null;
  let out: string | null = null;
  let name: string | null = null;
  let actorProfileId: string | null = null;
  let dryRun = false;

  const values = [...argv];
  while (values.length > 0) {
    const token = values.shift()!;
    if (!token.startsWith("--")) throw new Error(`Unknown argument "${token}"\n\n${OUTREACH_USAGE}`);
    const at = token.indexOf("=");
    const flag = (at === -1 ? token : token.slice(0, at)).slice(2);
    const inline = at === -1 ? null : token.slice(at + 1);
    const take = (): string => {
      if (inline !== null) return inline;
      const next = values.shift();
      if (next === undefined) throw new Error(`--${flag} needs a value\n\n${OUTREACH_USAGE}`);
      return next;
    };

    switch (flag) {
      case "segment": segments.push(take()); break;
      case "limit": limit = integer("limit", take()); break;
      case "coupon-percent": couponPercent = integer("coupon-percent", take()); break;
      case "out": out = take(); break;
      case "name": name = take(); break;
      case "actor": {
        const raw = take().trim();
        // It lands in audit_log.actor_id and coupons.created_by, both uuid
        // columns. Caught here rather than as a constraint violation three
        // statements into the transaction.
        if (!UUID.test(raw)) throw new Error(`--actor must be a profiles.id (uuid), got "${raw}"`);
        actorProfileId = raw;
        break;
      }
      case "dry-run": dryRun = true; break;
      default: throw new Error(`Unknown flag "--${flag}"\n\n${OUTREACH_USAGE}`);
    }
  }

  if (couponPercent === null) {
    throw new Error(`--coupon-percent is required\n\n${OUTREACH_USAGE}`);
  }
  if (couponPercent < 1 || couponPercent > 100) {
    throw new Error(`--coupon-percent must be between 1 and 100, got ${couponPercent}`);
  }
  const resolved = limit ?? DEFAULT_LIMIT;
  if (resolved < 1 || resolved > MAX_LIMIT) {
    throw new Error(`--limit must be between 1 and ${MAX_LIMIT}, got ${resolved}`);
  }

  return {
    segment: parseSegment(segments),
    limit: resolved,
    couponPercent,
    out,
    name,
    actorProfileId,
    dryRun,
  };
}
