import { siteConfig } from "@/config/site.config";
import type { FeatureFlag } from "@/config/types";

/**
 * Build-time constant, so `if (!features.reviews) return null` is tree-shaken
 * and disabled code never ships. Never replace this with a database read: a
 * runtime flag cannot be tree-shaken and cannot 404 a route.
 */
export const features = siteConfig.features;

export function isEnabled(flag: FeatureFlag): boolean {
  return features[flag];
}
