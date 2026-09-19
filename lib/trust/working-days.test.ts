import { describe, it, expect } from "vitest";
import { addWorkingDays, numberWord, removalDueAt, REMOVAL_SLA_WORKING_DAYS } from "./working-days";

const LONDON = "Europe/London";

function weekday(d: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-GB", { weekday: "short", timeZone: timezone }).format(d);
}

describe("addWorkingDays", () => {
  it("carries a Friday over the weekend to the Friday of the following week", () => {
    // The worked example in the brief: five working days from a Friday is the
    // next Friday, not the following Wednesday.
    const from = new Date("2026-06-12T10:00:00Z");
    expect(addWorkingDays(from, 5, LONDON).toISOString()).toBe("2026-06-19T10:00:00.000Z");
  });

  it("carries a Monday to the Monday of the following week", () => {
    const from = new Date("2026-06-08T10:00:00Z");
    expect(addWorkingDays(from, 5, LONDON).toISOString()).toBe("2026-06-15T10:00:00.000Z");
  });

  it("does not count the weekend a request arrives on", () => {
    // Saturday. The clock starts on the Monday, so the deadline is the Friday.
    const from = new Date("2026-06-13T10:00:00Z");
    expect(addWorkingDays(from, 5, LONDON).toISOString()).toBe("2026-06-19T10:00:00.000Z");
  });

  it("counts days in the given timezone, not the server's", () => {
    // 23:30 UTC on a Friday is already Saturday in London, so the two answers
    // differ by a day. A deadline computed in the wrong zone is a deadline we
    // miss by a day once a week.
    const from = new Date("2026-06-05T23:30:00Z");
    expect(addWorkingDays(from, 5, LONDON).toISOString()).toBe("2026-06-11T23:30:00.000Z");
    expect(addWorkingDays(from, 5, "UTC").toISOString()).toBe("2026-06-12T23:30:00.000Z");
  });

  it("still lands on the right weekday across a daylight-saving change", () => {
    // Clocks go forward in London on 2026-03-29. Days are added as fixed 24h
    // steps, so the wall-clock time drifts by an hour; the weekday must not.
    const from = new Date("2026-03-27T10:00:00Z");
    const due = addWorkingDays(from, 5, LONDON);
    expect(weekday(due, LONDON)).toBe("Fri");
    expect(due.toISOString()).toBe("2026-04-03T10:00:00.000Z");
  });

  it("returns the instant it was given when no days are asked for", () => {
    const from = new Date("2026-06-13T10:00:00Z");
    expect(addWorkingDays(from, 0, LONDON).toISOString()).toBe(from.toISOString());
  });

  it("never returns the Date it was handed", () => {
    // A mutated argument would quietly move whatever else holds that Date.
    const from = new Date("2026-06-12T10:00:00Z");
    const due = addWorkingDays(from, 5, LONDON);
    expect(due).not.toBe(from);
    expect(from.toISOString()).toBe("2026-06-12T10:00:00.000Z");
  });
});

describe("removalDueAt", () => {
  it("is five working days from the request", () => {
    expect(REMOVAL_SLA_WORKING_DAYS).toBe(5);
    const from = new Date("2026-06-12T10:00:00Z");
    expect(removalDueAt(from, LONDON).toISOString()).toBe(
      addWorkingDays(from, REMOVAL_SLA_WORKING_DAYS, LONDON).toISOString(),
    );
  });
});

describe("numberWord", () => {
  it("spells zero to twenty as single words", () => {
    expect(numberWord(0)).toBe("zero");
    expect(numberWord(1)).toBe("one");
    expect(numberWord(5)).toBe("five");
    expect(numberWord(10)).toBe("ten");
    expect(numberWord(11)).toBe("eleven");
    expect(numberWord(13)).toBe("thirteen");
    expect(numberWord(15)).toBe("fifteen");
    expect(numberWord(18)).toBe("eighteen");
    expect(numberWord(20)).toBe("twenty");
  });

  it("spells the tens as single words", () => {
    expect(numberWord(30)).toBe("thirty");
    expect(numberWord(40)).toBe("forty");
    expect(numberWord(50)).toBe("fifty");
    expect(numberWord(80)).toBe("eighty");
    expect(numberWord(90)).toBe("ninety");
  });

  it("hyphenates compounds from twenty-one to ninety-nine", () => {
    expect(numberWord(21)).toBe("twenty-one");
    expect(numberWord(42)).toBe("forty-two");
    expect(numberWord(67)).toBe("sixty-seven");
    expect(numberWord(99)).toBe("ninety-nine");
  });

  it("falls back to digits at one hundred and beyond", () => {
    expect(numberWord(100)).toBe("100");
    expect(numberWord(250)).toBe("250");
    expect(numberWord(1000)).toBe("1000");
  });

  it("falls back to digits for anything that is not a whole number in range", () => {
    expect(numberWord(-1)).toBe("-1");
    expect(numberWord(2.5)).toBe("2.5");
    expect(numberWord(Number.NaN)).toBe("NaN");
  });

  it("spells the SLA the copy actually uses", () => {
    expect(`${numberWord(REMOVAL_SLA_WORKING_DAYS)} working days`).toBe("five working days");
  });
});
