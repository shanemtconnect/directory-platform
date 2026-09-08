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

/** SITE_FLAGS_OVERRIDE is set only by the two CI builds; never in production. */
export function resolveFeatures(configured: FeatureMap): FeatureMap {
  switch (process.env.SITE_FLAGS_OVERRIDE) {
    case "off": return ALL_FLAGS_OFF;
    case "on": return ALL_FLAGS_ON;
    default: return configured;
  }
}
