import { describe, it, expect, vi, afterEach } from "vitest";
import { prerenderingWithoutDatabase } from "./build-phase";

describe("prerenderingWithoutDatabase", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("is true only during a production build with no database", () => {
    vi.stubEnv("NEXT_PHASE", "phase-production-build");
    vi.stubEnv("DATABASE_URL", undefined);
    expect(prerenderingWithoutDatabase()).toBe(true);
  });

  it("treats a blank DATABASE_URL as no database", () => {
    vi.stubEnv("NEXT_PHASE", "phase-production-build");
    vi.stubEnv("DATABASE_URL", "   ");
    expect(prerenderingWithoutDatabase()).toBe(true);
  });

  it("is false during a build that does have a database", () => {
    vi.stubEnv("NEXT_PHASE", "phase-production-build");
    vi.stubEnv("DATABASE_URL", "postgres://x");
    expect(prerenderingWithoutDatabase()).toBe(false);
  });

  // The important half: at runtime a missing database is an outage, not an
  // empty page. Nothing here may hide one.
  it("is false at runtime even with no DATABASE_URL", () => {
    vi.stubEnv("NEXT_PHASE", undefined);
    vi.stubEnv("DATABASE_URL", undefined);
    expect(prerenderingWithoutDatabase()).toBe(false);
    vi.stubEnv("NEXT_PHASE", "phase-production-server");
    expect(prerenderingWithoutDatabase()).toBe(false);
  });
});
