import type { FeatureFlag, FeatureMap } from "./types";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * Some flags are meaningless without others. Awards are computed from review
 * volume; quote broadcast selects from a shortlist. An unmet dependency fails
 * the build rather than warning — a half-wired feature is worse than an absent one.
 */
export const FEATURE_DEPENDENCIES: Partial<Record<FeatureFlag, readonly FeatureFlag[]>> = {
  awards: ["reviews"],
  quoteBroadcast: ["shortlist"],
};

export function validateFeatureDependencies(features: FeatureMap): void {
  const problems: string[] = [];
  for (const [flag, deps] of Object.entries(FEATURE_DEPENDENCIES)) {
    if (!features[flag as FeatureFlag]) continue;
    for (const dep of deps ?? []) {
      if (!features[dep]) problems.push(`${flag} requires ${dep}, which is off`);
    }
  }
  if (problems.length > 0) {
    throw new ConfigError(
      `Invalid feature configuration in config/site.config.ts:\n  - ${problems.join("\n  - ")}`,
    );
  }
}

/**
 * Needed to produce the build. Everything else is injected at boot, because the
 * image is built once in CI with no site secrets and then run per site with its
 * own .env. Requiring DATABASE_URL here would make the image unbuildable.
 */
const BUILD_ENV = ["NEXT_PUBLIC_SITE_URL"] as const;

const RUNTIME_ENV = [
  "NEXT_PUBLIC_SITE_URL",
  "DATABASE_URL",
  "REDIS_URL",
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_URL",
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET_MEDIA",
  "R2_BUCKET_CLAIM_DOCS",
  "NEXT_PUBLIC_MEDIA_URL",
  "PAYPAL_CLIENT_ID",
  "PAYPAL_CLIENT_SECRET",
  "PAYPAL_WEBHOOK_ID",
  "RESEND_API_KEY",
  "EMAIL_FROM",
  "ADMIN_NOTIFICATION_EMAIL",
  "TURNSTILE_SITE_KEY",
  "TURNSTILE_SECRET_KEY",
  "MAPTILER_KEY",
] as const;

export function validateEnv(
  env: Record<string, string | undefined>,
  opts: { phase: "build" | "runtime" },
): void {
  const required: readonly string[] = opts.phase === "build" ? BUILD_ENV : RUNTIME_ENV;
  const missing = required.filter((k) => {
    const v = env[k];
    return v === undefined || v.trim() === "";
  });
  if (missing.length > 0) {
    throw new ConfigError(
      `Missing required environment variables (${opts.phase}):\n  - ${missing.join("\n  - ")}\n` +
        `See .env.example. A site that boots without these is worse than one that refuses to.`,
    );
  }
}

