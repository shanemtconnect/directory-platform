import type { EmptySpotRow } from "./availability";
import { leaderboardPath } from "./notify";

/**
 * The outreach CSV (Task 45, requirement 5): one line per open spot with
 * room. Amounts in major units — the reader is a person with a spreadsheet,
 * not the billing code. RFC 4180 quoting; CRLF; no trailing newline.
 */

const HEADER = [
  "area_kind", "area", "category", "filled", "positions", "empty", "floor", "top", "page_url", "leaderboard_url",
] as const;

export function csvLine(fields: readonly (string | number)[]): string {
  return fields
    .map((f) => {
      const s = String(f);
      return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    })
    .join(",");
}

export function emptySpotsCsv(rows: readonly EmptySpotRow[], origin: string): string {
  const lines = [csvLine(HEADER)];
  for (const r of rows) {
    if (r.status !== "open" || r.filled >= r.positions) continue;
    lines.push(
      csvLine([
        r.key.areaKind,
        r.areaName,
        r.categoryName ?? "",
        r.filled,
        r.positions,
        r.positions - r.filled,
        Math.round(r.floorCents / 100),
        r.topCents === null ? "" : Math.round(r.topCents / 100),
        r.path === null ? "" : `${origin}${r.path}`,
        r.spotId === null ? "" : `${origin}${leaderboardPath(r.spotId)}`,
      ]),
    );
  }
  return lines.join("\r\n");
}
