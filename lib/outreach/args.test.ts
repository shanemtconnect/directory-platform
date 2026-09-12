import { describe, it, expect } from "vitest";
import { parseOutreachArgs, OUTREACH_USAGE } from "./args";

describe("parseOutreachArgs", () => {
  it("reads the documented invocation", () => {
    expect(
      parseOutreachArgs(["--segment", "city=leeds", "--limit", "50", "--coupon-percent", "50"]),
    ).toEqual({
      segment: { city: "leeds" },
      limit: 50,
      couponPercent: 50,
      out: null,
      name: null,
      actorProfileId: null,
      dryRun: false,
    });
  });

  it("accepts --key=value as well as --key value", () => {
    const parsed = parseOutreachArgs(["--segment=city=leeds", "--limit=10", "--coupon-percent=25"]);
    expect(parsed).toMatchObject({ segment: { city: "leeds" }, limit: 10, couponPercent: 25 });
  });

  it("takes repeated segments", () => {
    const parsed = parseOutreachArgs([
      "--segment", "city=leeds", "--segment", "category=halls", "--coupon-percent", "50",
    ]);
    expect(parsed.segment).toEqual({ city: "leeds", category: "halls" });
  });

  it("reads --out, --name and --dry-run", () => {
    const parsed = parseOutreachArgs([
      "--coupon-percent", "50", "--out", "batch.csv", "--name", "Spring push", "--dry-run",
    ]);
    expect(parsed).toMatchObject({ out: "batch.csv", name: "Spring push", dryRun: true });
  });

  it("defaults the limit to something a person can check by hand", () => {
    expect(parseOutreachArgs(["--coupon-percent", "50"]).limit).toBe(50);
  });

  it("requires a coupon percentage — silently sending no discount is not a default", () => {
    expect(() => parseOutreachArgs([])).toThrow(/coupon-percent/);
  });

  it("refuses a limit that is not a positive whole number", () => {
    for (const limit of ["0", "-5", "abc", "1.5"]) {
      expect(() => parseOutreachArgs(["--coupon-percent", "50", "--limit", limit])).toThrow(/limit/i);
    }
  });

  it("refuses a percentage outside 1-100", () => {
    for (const percent of ["0", "101", "abc"]) {
      expect(() => parseOutreachArgs(["--coupon-percent", percent])).toThrow(/percent/i);
    }
  });

  it("caps the limit, so one typo cannot email the whole database", () => {
    expect(() => parseOutreachArgs(["--coupon-percent", "50", "--limit", "100000"])).toThrow(/limit/i);
  });

  it("takes an --actor profile id and defaults it to null", () => {
    expect(parseOutreachArgs(["--coupon-percent", "50"]).actorProfileId).toBeNull();
    const id = "3f2b0c9e-1111-4222-8333-444455556666";
    expect(parseOutreachArgs(["--coupon-percent", "50", "--actor", id]).actorProfileId).toBe(id);
    expect(parseOutreachArgs(["--coupon-percent", "50", `--actor=${id}`]).actorProfileId).toBe(id);
  });

  it("refuses an --actor that is not a uuid", () => {
    // It goes into audit_log.actor_id and coupons.created_by, both uuid
    // columns. A typo should be a usage error, not a constraint violation
    // three statements into a transaction.
    for (const bad of ["me", "admin@example.com", "3f2b0c9e-1111-4222-8333"]) {
      expect(() => parseOutreachArgs(["--coupon-percent", "50", "--actor", bad])).toThrow(/actor/i);
    }
  });

  it("refuses a flag it does not know", () => {
    expect(() => parseOutreachArgs(["--coupon-percent", "50", "--send"])).toThrow(/unknown/i);
    expect(OUTREACH_USAGE).toContain("--segment");
  });
});
