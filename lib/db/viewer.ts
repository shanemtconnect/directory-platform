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

/**
 * The viewer the worker runs as.
 *
 * Background jobs have no session and no request to derive a viewer from, but
 * every query function still takes one — so the worker declares its authority
 * explicitly here rather than each job inventing its own admin object. The id
 * is the nil UUID: it is a real UUID so it cannot break a comparison, and it
 * can never match a row's owner_id.
 */
export const ADMIN_VIEWER: Viewer = {
  role: "admin",
  userId: "00000000-0000-0000-0000-000000000000",
};
