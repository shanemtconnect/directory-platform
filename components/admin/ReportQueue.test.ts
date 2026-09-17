import { describe, it, expect } from "vitest";
import { age } from "./ReportQueue";

/**
 * How old a report reads as.
 *
 * `now` is handed down from the server render rather than read in the browser,
 * so this is a pure function of two instants — which is the only way the
 * server's HTML and the client's first render can agree on the word "ago".
 */

const FILED = new Date("2026-09-08T12:00:00Z");

function at(iso: string): string {
  return age(FILED, new Date(iso));
}

describe("age", () => {
  it("reads as minutes within the hour", () => {
    expect(at("2026-09-08T12:20:00Z")).toBe("20 min ago");
  });

  it("reads as just now for something that has only landed", () => {
    expect(at("2026-09-08T12:00:20Z")).toBe("just now");
  });

  it("switches to hours, singular at one", () => {
    expect(at("2026-09-08T13:00:00Z")).toBe("1 hour ago");
    expect(at("2026-09-09T00:00:00Z")).toBe("12 hours ago");
  });

  it("switches to days once hours stop meaning anything", () => {
    expect(at("2026-09-11T12:00:00Z")).toBe("3 days ago");
  });

  it("never reports a future timestamp as negative", () => {
    // Clock skew between the app server and Postgres is real and a report that
    // claims to be "-1 min ago" looks like a bug in the queue rather than in
    // somebody's NTP.
    expect(at("2026-09-08T11:58:00Z")).toBe("just now");
  });
});
