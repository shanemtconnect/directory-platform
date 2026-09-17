import { describe, it, expect } from "vitest";
import { dueState } from "./RemovalQueue";

/**
 * The overdue marker.
 *
 * This is the only piece of the removal queue that is a decision rather than a
 * rendering: the site promises a decision inside five working days, `due_at` is
 * when that promise falls due, and this is what says whether it has been
 * broken. Worth pinning on both sides of the boundary and on the row shape the
 * SLA column predates.
 */

const DUE = new Date("2026-09-10T12:00:00Z");

describe("dueState", () => {
  it("is not overdue while the deadline is still ahead", () => {
    const state = dueState(DUE, new Date("2026-09-09T12:00:00Z"));

    expect(state.overdue).toBe(false);
    expect(state.label).toMatch(/^Due /);
  });

  it("is not overdue at the moment the deadline falls", () => {
    // The promise is "inside five working days", so the instant it is due is
    // still inside it. Treating the boundary as late would flag a request the
    // admin has not actually missed.
    expect(dueState(DUE, DUE).overdue).toBe(false);
  });

  it("is overdue one day after the deadline, and says so in days", () => {
    const state = dueState(DUE, new Date("2026-09-11T12:00:00Z"));

    expect(state.overdue).toBe(true);
    expect(state.label).toBe("Overdue by 1 day");
  });

  it("counts the days it is late", () => {
    const state = dueState(DUE, new Date("2026-09-14T12:00:00Z"));

    expect(state).toEqual({ overdue: true, label: "Overdue by 4 days" });
  });

  it("never rounds a missed deadline down to nothing", () => {
    // A minute late is late. Rounding to the nearest day would report "0 days"
    // for the first twelve hours of a breach.
    const state = dueState(DUE, new Date("2026-09-10T12:01:00Z"));

    expect(state).toEqual({ overdue: true, label: "Overdue by 1 day" });
  });

  it("says the deadline is unknown rather than assuming a row is on time", () => {
    // `due_at` is nullable: rows filed before the column existed have none.
    const state = dueState(null, new Date("2026-09-14T12:00:00Z"));

    expect(state.overdue).toBe(false);
    expect(state.label).toBe("No deadline recorded");
  });
});
