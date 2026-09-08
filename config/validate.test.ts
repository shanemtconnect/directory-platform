import { describe, it, expect, vi, afterEach } from "vitest";
import {
  validateFeatureDependencies,
  validateEnv,
  validateCountry,
  validateProductionConfig,
  ConfigError,
  RUNTIME_ENV,
  RUNTIME_ENV_PHASE5,
} from "./validate";
import { siteConfig } from "./site.config";
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
};

const BUILD = {
  NEXT_PUBLIC_SITE_URL: "https://x.test",
  NEXT_PUBLIC_MAPTILER_KEY: "k",
  NEXT_PUBLIC_MEDIA_URL: "https://m.test",
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("validateEnv", () => {
  it("passes when every required key is present at runtime", () => {
    expect(() => validateEnv(RUNTIME, { phase: "runtime" })).not.toThrow();
  });

  it("throws naming every missing key, not just the first", () => {
    const { DATABASE_URL: _d, REDIS_URL: _r, ...rest } = RUNTIME;
    expect(() => validateEnv(rest, { phase: "runtime" })).toThrow(/DATABASE_URL[\s\S]*REDIS_URL/);
  });

  it("treats an empty string as missing", () => {
    expect(() => validateEnv({ ...RUNTIME, DATABASE_URL: "" }, { phase: "runtime" }))
      .toThrow(/DATABASE_URL/);
  });

  it("treats whitespace as missing", () => {
    expect(() => validateEnv({ ...RUNTIME, REDIS_URL: "   " }, { phase: "runtime" }))
      .toThrow(/REDIS_URL/);
  });

  it("does not require runtime secrets during the build", () => {
    expect(() => validateEnv({ NEXT_PUBLIC_SITE_URL: "https://x.test" }, { phase: "build" }))
      .not.toThrow();
  });

  it("still requires the build keys during the build", () => {
    expect(() => validateEnv({}, { phase: "build" })).toThrow(/NEXT_PUBLIC_SITE_URL/);
  });

  // Requirement 5: only the variables whose features are wired today are
  // enforced at boot. A site that refuses to start over a PayPal key it never
  // reads is a self-inflicted outage.
  it("does not yet require the later-phase keys at runtime", () => {
    expect(() => validateEnv(RUNTIME, { phase: "runtime" })).not.toThrow();
    expect(RUNTIME_ENV).toEqual([
      "NEXT_PUBLIC_SITE_URL",
      "DATABASE_URL",
      "REDIS_URL",
      "BETTER_AUTH_SECRET",
      "BETTER_AUTH_URL",
    ]);
  });

  // Auth is live, so its keys are boot requirements rather than a checklist
  // entry: a signing secret that changes between boots invalidates every
  // session cookie already issued.
  it("requires the Better Auth keys at runtime now that auth is wired", () => {
    const { BETTER_AUTH_SECRET: _s, ...noSecret } = RUNTIME;
    expect(() => validateEnv(noSecret, { phase: "runtime" })).toThrow(/BETTER_AUTH_SECRET/);
    const { BETTER_AUTH_URL: _u, ...noUrl } = RUNTIME;
    expect(() => validateEnv(noUrl, { phase: "runtime" })).toThrow(/BETTER_AUTH_URL/);
  });

  it("still does not require the auth keys during the build", () => {
    expect(() => validateEnv({ NEXT_PUBLIC_SITE_URL: "https://x.test" }, { phase: "build" }))
      .not.toThrow();
  });

  it("keeps the later-phase keys documented rather than deleted", () => {
    for (const key of [
      "R2_ACCOUNT_ID",
      "R2_ACCESS_KEY_ID",
      "R2_SECRET_ACCESS_KEY",
      "R2_BUCKET_MEDIA",
      "R2_BUCKET_CLAIM_DOCS",
      "PAYPAL_CLIENT_ID",
      "PAYPAL_CLIENT_SECRET",
      "PAYPAL_WEBHOOK_ID",
      "RESEND_API_KEY",
      "EMAIL_FROM",
      "ADMIN_NOTIFICATION_EMAIL",
    ]) {
      expect(RUNTIME_ENV_PHASE5).toContain(key);
    }
  });

  it("does not enforce the later-phase list at runtime", () => {
    for (const key of RUNTIME_ENV_PHASE5) {
      expect(RUNTIME_ENV).not.toContain(key);
    }
  });

  // Requirement 6: NEXT_PUBLIC_ vars are inlined at build time, so listing them
  // as runtime keys was a lie — a value injected at boot is ignored.
  it("does not treat the inlined NEXT_PUBLIC_ keys as runtime keys", () => {
    expect(RUNTIME_ENV).not.toContain("NEXT_PUBLIC_MAPTILER_KEY");
    expect(RUNTIME_ENV).not.toContain("NEXT_PUBLIC_MEDIA_URL");
    expect(RUNTIME_ENV_PHASE5).not.toContain("NEXT_PUBLIC_MAPTILER_KEY");
    expect(RUNTIME_ENV_PHASE5).not.toContain("NEXT_PUBLIC_MEDIA_URL");
  });

  it("warns rather than throws when an optional build key is absent", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => validateEnv({ NEXT_PUBLIC_SITE_URL: "https://x.test" }, { phase: "build" }))
      .not.toThrow();
    const said = warn.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(said).toMatch(/NEXT_PUBLIC_MAPTILER_KEY/);
    expect(said).toMatch(/NEXT_PUBLIC_MEDIA_URL/);
  });

  it("stays quiet when the optional build keys are present", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    validateEnv(BUILD, { phase: "build" });
    expect(warn).not.toHaveBeenCalled();
  });

  it("does not warn about optional build keys at runtime", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    validateEnv(RUNTIME, { phase: "runtime" });
    expect(warn).not.toHaveBeenCalled();
  });
});

// Requirement 7: placeholders are fine in a clone that has not been filled in
// yet, and unacceptable in something serving the public.
describe("validateProductionConfig", () => {
  const placeholder = {
    legalEntity: "TBC",
    supportEmail: "hello@example.co.uk",
    dataController: "TBC",
  };
  const real = {
    legalEntity: "Example Directories Ltd",
    supportEmail: "hello@realsite.co.uk",
    dataController: "Example Directories Ltd",
  };
  const prod = { NODE_ENV: "production", NEXT_PUBLIC_SITE_URL: "https://realsite.co.uk" };

  it("throws on a production build that still says TBC", () => {
    expect(() => validateProductionConfig(placeholder, prod)).toThrow(ConfigError);
    expect(() => validateProductionConfig(placeholder, prod)).toThrow(/legalEntity/);
  });

  it("throws on a production build with an example.co.uk support address", () => {
    expect(() => validateProductionConfig({ ...real, supportEmail: "a@example.co.uk" }, prod))
      .toThrow(/supportEmail/);
  });

  it("throws on a production build with an example.com support address", () => {
    expect(() => validateProductionConfig({ ...real, supportEmail: "a@example.com" }, prod))
      .toThrow(/supportEmail/);
  });

  // dataController defaults to the same "TBC" placeholder as legalEntity
  // (config/site.config.ts's `legal.dataController`), and reaches the privacy
  // policy naming who is legally responsible for visitor data — a wrong
  // answer there is worse than a missing one, so it fails the build the same
  // way legalEntity does.
  it("throws on a production build with dataController still TBC", () => {
    expect(() => validateProductionConfig({ ...real, dataController: "TBC" }, prod))
      .toThrow(/dataController/);
  });

  it("reports every placeholder, not just the first", () => {
    expect(() => validateProductionConfig(placeholder, prod))
      .toThrow(/legalEntity[\s\S]*dataController[\s\S]*supportEmail/);
  });

  it("passes on a production build once both are real", () => {
    expect(() => validateProductionConfig(real, prod)).not.toThrow();
  });

  it("allows placeholders on staging, where nobody is being invoiced", () => {
    expect(() => validateProductionConfig(placeholder, { ...prod, SITE_ENV: "staging" }))
      .not.toThrow();
  });

  it("allows placeholders outside a production build", () => {
    expect(() => validateProductionConfig(placeholder, { NODE_ENV: "development" })).not.toThrow();
    expect(() => validateProductionConfig(placeholder, {})).not.toThrow();
  });

  // `next build` sets NODE_ENV=production unconditionally, so NODE_ENV alone
  // cannot tell a release apart from `pnpm build:flags-off` or the e2e build.
  // A site nobody can reach is not shipping placeholders to anybody.
  it("allows placeholders on a build that cannot be a real site", () => {
    for (const url of [
      "http://localhost:3200",
      "http://127.0.0.1:3000",
      // WHATWG URL keeps the brackets on an IPv6 hostname: `new URL("http://[::1]/").hostname`
      // is "[::1]", never "::1". A bare-"::1" comparison is a branch that can never be taken.
      "http://[::1]:3000",
      "https://ci.example",
      "https://x.test",
      "http://directory.local",
      "https://nope.invalid",
    ]) {
      expect(() => validateProductionConfig(placeholder, { ...prod, NEXT_PUBLIC_SITE_URL: url }))
        .not.toThrow();
    }
  });

  it("still fires on a real domain that merely looks like an example", () => {
    expect(() =>
      validateProductionConfig(placeholder, { ...prod, NEXT_PUBLIC_SITE_URL: "https://example.io" }),
    ).toThrow(ConfigError);
  });
});

describe("validateCountry", () => {
  it("passes for the shipped config", () => {
    expect(() => validateCountry(siteConfig)).not.toThrow();
  });

  it("accepts every supported market with its own currency and locale", () => {
    const markets = [
      { country: "GB", currency: "GBP", locale: "en-GB" },
      { country: "US", currency: "USD", locale: "en-US" },
      { country: "AU", currency: "AUD", locale: "en-AU" },
      { country: "CA", currency: "CAD", locale: "en-CA" },
    ];
    for (const m of markets) expect(() => validateCountry(m)).not.toThrow();
  });

  it("throws on an unsupported country", () => {
    expect(() => validateCountry({ country: "XX", currency: "USD", locale: "en-XX" }))
      .toThrow(/Unsupported country/);
  });

  it("catches a US site left quoting prices in pounds", () => {
    expect(() => validateCountry({ country: "US", currency: "GBP", locale: "en-US" }))
      .toThrow(/unusual for United States/);
  });

  it("catches a locale that does not match the country", () => {
    expect(() => validateCountry({ country: "US", currency: "USD", locale: "en-GB" }))
      .toThrow(/does not match country/);
  });
});
