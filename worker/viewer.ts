import type { Viewer } from "@/lib/db/viewer";

/**
 * The viewer the worker runs as.
 *
 * Background jobs have no session and no request to derive a viewer from, but
 * every query function still takes one — so the worker declares its authority
 * explicitly here rather than each job inventing its own admin object. The id
 * is the nil UUID: it is a real UUID so it cannot break a comparison, and it
 * can never match a row's owner_id.
 *
 * It lives under worker/ and not in lib/db/viewer.ts deliberately. A ready-made
 * admin viewer sitting next to PUBLIC_VIEWER is an invitation for request-path
 * code to import it and hand itself admin rights past every gate in
 * lib/db/queries/. Nothing served to a browser has any business importing from
 * this directory.
 */
export const ADMIN_VIEWER: Viewer = {
  role: "admin",
  userId: "00000000-0000-0000-0000-000000000000",
};
