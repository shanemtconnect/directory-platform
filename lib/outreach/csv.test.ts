import { describe, it, expect } from "vitest";
import { outreachCsv, OUTREACH_CSV_HEADER, type OutreachRow } from "./csv";

const row = (patch: Partial<OutreachRow> = {}): OutreachRow => ({
  address: "owner@old-mill.example",
  businessName: "The Old Mill",
  magicUrl: "https://dir.example/claim/outreach/abc123",
  couponCode: "SAVE50-7KQP4M",
  ...patch,
});

describe("outreachCsv", () => {
  it("starts with the header the sending tool imports", () => {
    const lines = outreachCsv([row()]).split("\r\n");
    expect(lines[0]).toBe(OUTREACH_CSV_HEADER);
    expect(lines[1]).toBe(
      "owner@old-mill.example,The Old Mill,https://dir.example/claim/outreach/abc123,SAVE50-7KQP4M",
    );
  });

  it("emits the header alone for an empty batch", () => {
    expect(outreachCsv([])).toBe(`${OUTREACH_CSV_HEADER}\r\n`);
  });

  it("quotes and doubles up on commas, quotes and newlines", () => {
    const csv = outreachCsv([row({ businessName: 'Smith, "Jones" &\nCo' })]);
    expect(csv).toContain('"Smith, ""Jones"" &\nCo"');
  });

  it("neutralises a formula so a spreadsheet does not execute the business name", () => {
    // A name starting =, +, - or @ is run as a formula by Excel and Sheets.
    // These files are opened by whoever does the sending.
    for (const name of ["=HYPERLINK(1)", "+1", "-1", "@SUM(A1)"]) {
      const csv = outreachCsv([row({ businessName: name })]);
      expect(csv).toContain(`"'${name}"`);
    }
  });

  it("ends every line with CRLF, which is what RFC 4180 says", () => {
    const csv = outreachCsv([row(), row({ address: "b@example.com" })]);
    expect(csv.split("\r\n")).toHaveLength(4); // header, two rows, trailing empty
    expect(csv.endsWith("\r\n")).toBe(true);
  });

  it("neutralises a formula hiding behind leading whitespace", () => {
    // Spreadsheets trim the cell before deciding what it is, so " =HYPERLINK()"
    // is every bit as live as "=HYPERLINK()" — and a guard anchored at the
    // very first character never sees it.
    const out = outreachCsv([
      { address: "a@a.example", businessName: "  =HYPERLINK(\"http://evil\")", magicUrl: "u", couponCode: "C" },
    ]);
    expect(out).toContain(`"'  =HYPERLINK`);
  });

  it.each(["\t=cmd", " +1+1", "\r-2-2", "  @SUM(A1)"])(
    "guards %j whatever whitespace precedes it",
    (name) => {
      const out = outreachCsv([
        { address: "a@a.example", businessName: name, magicUrl: "u", couponCode: "C" },
      ]);
      expect(out).toContain(`"'${name}`);
    },
  );
});