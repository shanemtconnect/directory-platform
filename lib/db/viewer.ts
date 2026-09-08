/**
 * Every query function in lib/db/queries/ takes one of these and applies its
 * own filter. A query function without a viewer is a bug — there is no RLS
 * behind this, so the data layer is the only gate.
 */
export type Viewer =
  | { role: "public" }
  | { role: "user"; userId: string }
  | { role: "owner"; userId: string }
  | { role: "admin"; userId: string };

export const PUBLIC_VIEWER: Viewer = { role: "public" };

export function isAdmin(v: Viewer): boolean {
  return v.role === "admin";
}
