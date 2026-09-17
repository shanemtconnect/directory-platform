import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { markAlive } from "./liveness";

describe("markAlive", () => {
  it("writes the current time to the file and reports success", () => {
    const dir = mkdtempSync(join(tmpdir(), "liveness-"));
    const file = join(dir, "alive");
    const now = () => new Date("2026-09-17T19:30:00.000Z");

    expect(markAlive(file, now)).toBe(true);

    expect(readFileSync(file, "utf8")).toBe("2026-09-17T19:30:00.000Z");
    expect(statSync(file).mtimeMs).toBeGreaterThan(0);
  });

  it("returns false rather than throwing when the path cannot be written", () => {
    const dir = mkdtempSync(join(tmpdir(), "liveness-"));
    // A directory that does not exist: writeFileSync cannot create parents.
    expect(markAlive(join(dir, "missing", "alive"))).toBe(false);
  });
});
