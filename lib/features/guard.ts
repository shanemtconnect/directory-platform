import { notFound } from "next/navigation";
import type { FeatureFlag } from "@/config/types";
import { features } from "./flags";

/**
 * First line of every optional route segment. A disabled feature returns a real
 * 404, not an empty page — an empty page is a thin-content signal and a dead
 * end for anyone who followed a stale link.
 */
export function guardFeature(flag: FeatureFlag): void {
  if (!features[flag]) notFound();
}
