import { describe, it, expect, vi, afterEach } from "vitest";
import { resolveFeatures, ALL_FLAGS_OFF, ALL_FLAGS_ON } from "./flag-variants";
import { FEATURE_FLAGS, type FeatureMap } from "./types";

// A deliberately mixed map, so "returned the configured map" is distinguishable
// from either override by value alone.
const configured = Object.fromEntries(
  FEATURE_FLAGS.map((f, i) => [f, i % 2 === 0]),
) as FeatureMap;

describe("resolveFeatures", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns the configured map when no override is set", () => {
    expect(resolveFeatures(configured, {})).toEqual(configured);
    expect(resolveFeatures(configured, { SITE_FLAGS_OVERRIDE: "" })).toEqual(configured);
    expect(resolveFeatures(configured, { SITE_FLAGS_OVERRIDE: "maybe" })).toEqual(configured);
  });

  it("applies on/off outside production", () => {
    expect(resolveFeatures(configured, { SITE_FLAGS_OVERRIDE: "on" })).toEqual(ALL_FLAGS_ON);
    expect(resolveFeatures(configured, { SITE_FLAGS_OVERRIDE: "off" })).toEqual(ALL_FLAGS_OFF);
    expect(resolveFeatures(configured, { SITE_FLAGS_OVERRIDE: "on", SITE_ENV: "staging" }))
      .toEqual(ALL_FLAGS_ON);
  });

  it("is a no-op under SITE_ENV=production, and says so once", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveFeatures(configured, { SITE_FLAGS_OVERRIDE: "on", SITE_ENV: "production" }))
      .toEqual(configured);
    expect(resolveFeatures(configured, { SITE_FLAGS_OVERRIDE: "off", SITE_ENV: "production" }))
      .toEqual(configured);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/SITE_FLAGS_OVERRIDE=on ignored/);
  });

  it("does not warn in production when nothing is overridden", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    resolveFeatures(configured, { SITE_ENV: "production" });
    expect(warn).not.toHaveBeenCalled();
  });
});
