/**
 * The export a batch exists to produce.
 *
 * Sending is deliberately not in this codebase: our transactional provider is
 * for transactional mail, and pushing cold outreach through it is how a domain
 * loses its reputation and takes every enquiry notification down with it. The
 * batch ends at a file, which a separate outreach-capable tool sends.
 */

export interface OutreachRow {
  /** The business's published address. */
  address: string;
  businessName: string;
  /** /claim/outreach/{token} — one token, one recipient. */
  magicUrl: string;
  couponCode: string;
}

export const OUTREACH_CSV_HEADER = "email,business_name,magic_url,coupon_code";

/**
 * A leading =, +, - or @ makes Excel and Google Sheets treat the cell as a
 * formula. The names in this file come from an import feed, so "=HYPERLINK(...)"
 * is a live payload aimed at whoever opens the export. Prefixing an apostrophe
 * is the standard neutraliser; the cell still reads correctly.
 */
function escapeCell(value: string): string {
  const risky = /^[=+\-@\t\r]/.test(value);
  const guarded = risky ? `'${value}` : value;
  // A guarded cell is always quoted too: unquoted, the leading apostrophe is
  // ambiguous enough that some importers strip it and hand the formula back.
  return risky || /[",\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

export function outreachCsv(rows: OutreachRow[]): string {
  const lines = [OUTREACH_CSV_HEADER];
  for (const row of rows) {
    lines.push(
      [row.address, row.businessName, row.magicUrl, row.couponCode].map(escapeCell).join(","),
    );
  }
  // CRLF and a trailing newline: RFC 4180, and what every spreadsheet expects.
  return `${lines.join("\r\n")}\r\n`;
}
