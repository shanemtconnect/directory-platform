import { describe, it, expect, afterEach } from "vitest";
import { now, setClock, resetClock } from "./clock";

describe("clock", () => {
  afterEach(resetClock);

  it("returns the real time by default", () => {
    expect(Math.abs(now().getTime() - Date.now())).toBeLessThan(1000);
  });

  it("returns the frozen time once set", () => {
    const t = new Date("2027-03-01T12:00:00.000Z");
    setClock(t);
    expect(now().toISOString()).toBe("2027-03-01T12:00:00.000Z");
  });

  it("keeps returning the frozen time on repeated calls", () => {
    setClock(new Date("2027-03-01T12:00:00.000Z"));
    expect(now().toISOString()).toBe(now().toISOString());
  });

  it("returns a copy, so a caller cannot mutate the frozen instant", () => {
    setClock(new Date("2027-03-01T12:00:00.000Z"));
    const a = now();
    a.setFullYear(1999);
    expect(now().toISOString()).toBe("2027-03-01T12:00:00.000Z");
  });

  it("goes back to real time after reset", () => {
    setClock(new Date("2027-03-01T00:00:00.000Z"));
    resetClock();
    expect(Math.abs(now().getTime() - Date.now())).toBeLessThan(1000);
  });
});
