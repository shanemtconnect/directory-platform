import { describe, it, expect } from "vitest";
import { validateFeatureDependencies, validateEnv, ConfigError } from "./validate";
import { FEATURE_FLAGS, type FeatureFlag, type FeatureMap } from "./types";

const allOff = Object.fromEntries(FEATURE_FLAGS.map((f) => [f, false])) as FeatureMap;
const allOn = Object.fromEntries(FEATURE_FLAGS.map((f) => [f, true])) as FeatureMap;
const on = (...flags: FeatureFlag[]): FeatureMap =>
  ({ ...allOff, ...Object.fromEntries(flags.map((f) => [f, true])) }) as FeatureMap;

describe("validateFeatureDependencies", () => {
  it("passes when everything is off", () => {
    expect(() => validateFeatureDependencies(allOff)).not.toThrow();
  });

  it("throws when awards is on without reviews", () => {
    expect(() => validateFeatureDependencies(on("awards"))).toThrow(ConfigError);
    expect(() => validateFeatureDependencies(on("awards"))).toThrow(/awards requires reviews/);
  });

  it("passes when awards is on with reviews", () => {
    expect(() => validateFeatureDependencies(on("awards", "reviews"))).not.toThrow();
  });

  it("throws when quoteBroadcast is on without shortlist", () => {
    expect(() => validateFeatureDependencies(on("quoteBroadcast"))).toThrow(/requires shortlist/);
  });

  it("reports every unmet dependency, not just the first", () => {
    expect(() => validateFeatureDependencies(on("awards", "quoteBroadcast")))
      .toThrow(/awards requires reviews[\s\S]*quoteBroadcast requires shortlist/);
  });

  it("passes with every flag on — the unit mirror of build:flags-on", () => {
    expect(() => validateFeatureDependencies(allOn)).not.toThrow();
  });
});

const RUNTIME = {
  NEXT_PUBLIC_SITE_URL: "https://x.test",
  DATABASE_URL: "postgres://x",
  REDIS_URL: "redis://x",
  BETTER_AUTH_SECRET: "s",
  BETTER_AUTH_URL: "https://x.test",
  R2_ACCOUNT_ID: "a",
  R2_ACCESS_KEY_ID: "b",
  R2_SECRET_ACCESS_KEY: "c",
  R2_BUCKET_MEDIA: "m",
  R2_BUCKET_CLAIM_DOCS: "d",
  NEXT_PUBLIC_MEDIA_URL: "https://m.test",
  PAYPAL_CLIENT_ID: "p",
  PAYPAL_CLIENT_SECRET: "q",
  PAYPAL_WEBHOOK_ID: "w",
  RESEND_API_KEY: "r",
  EMAIL_FROM: "e@x.test",
  ADMIN_NOTIFICATION_EMAIL: "a@x.test",
  TURNSTILE_SITE_KEY: "t",
  TURNSTILE_SECRET_KEY: "u",
  MAPTILER_KEY: "k",
};

describe("validateEnv", () => {
  it("passes when every required key is present at runtime", () => {
    expect(() => validateEnv(RUNTIME, { phase: "runtime" })).not.toThrow();
  });

  it("throws naming every missing key, not just the first", () => {
    const { DATABASE_URL: _d, RESEND_API_KEY: _r, ...rest } = RUNTIME;
    expect(() => validateEnv(rest, { phase: "runtime" })).toThrow(/DATABASE_URL[\s\S]*RESEND_API_KEY/);
  });

  it("treats an empty string as missing", () => {
    expect(() => validateEnv({ ...RUNTIME, MAPTILER_KEY: "" }, { phase: "runtime" }))
      .toThrow(/MAPTILER_KEY/);
  });

  it("treats whitespace as missing", () => {
    expect(() => validateEnv({ ...RUNTIME, RESEND_API_KEY: "   " }, { phase: "runtime" }))
      .toThrow(/RESEND_API_KEY/);
  });

  it("does not require runtime secrets during the build", () => {
    expect(() => validateEnv({ NEXT_PUBLIC_SITE_URL: "https://x.test" }, { phase: "build" }))
      .not.toThrow();
  });

  it("still requires the build keys during the build", () => {
    expect(() => validateEnv({}, { phase: "build" })).toThrow(/NEXT_PUBLIC_SITE_URL/);
  });
});
