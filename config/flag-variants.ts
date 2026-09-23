import { FEATURE_FLAGS, type FeatureMap } from "./types";

/**
 * Used by build:flags-off and build:flags-on. Both must build clean with zero
 * dead links before a phase is done — this is the only thing that stops flags
 * rotting, and rotting flags are the specific way this codebase dies.
 */
export const ALL_FLAGS_OFF = Object.fromEntries(
  FEATURE_FLAGS.map((f) => [f, false]),
) as FeatureMap;

export const ALL_FLAGS_ON = Object.fromEntries(
  FEATURE_FLAGS.map((f) => [f, true]),
) as FeatureMap;

/**
 * SITE_FLAGS_OVERRIDE is set by the two CI builds (`build:flags-off`,
 * `build:flags-on`) and by staging image builds, so every module renders for
 * review. It is a no-op under SITE_ENV=production — enforced here, not by
 * convention — so a stray build arg can never flip flags on a real site.
 * The result is frozen into the bundle by `lib/features/flags.ts`, which is
 * why this reads the env at build time and why the guard has to live here.
 */
export function resolveFeatures(
  configured: FeatureMap,
  env: Record<string, string | undefined> = process.env,
): FeatureMap {
  const override = env.SITE_FLAGS_OVERRIDE;
  if (override !== "off" && override !== "on") return configured;
  if (env.SITE_ENV === "production") {
    console.warn(
      `[flags] SITE_FLAGS_OVERRIDE=${override} ignored: SITE_ENV=production never takes a flag override`,
    );
    return configured;
  }
  return override === "off" ? ALL_FLAGS_OFF : ALL_FLAGS_ON;
}
