"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db/client";
import { requireAdmin } from "@/lib/auth/viewer";
import { clientIp } from "@/lib/spam/client-ip";
import { getPayPalClient } from "@/lib/billing/paypal";
import { closeSpot, openSpot, setSpotFloor, type AdminSpotResult, type SpotKey } from "@/lib/db/queries/spots";
import { settleSpots } from "@/lib/spots/engine";
import { revalidateListingPaths } from "@/lib/revalidate/listing";
import { isUuid } from "@/lib/actions/validation";
import { UNIT_CENTS } from "@/lib/spots/rank";
import type { TestDb } from "@/lib/db/types";

/**
 * The admin availability table's buttons (Task 45). Every one re-checks
 * `requireAdmin()` — the layout is not a security boundary for actions
 * (constraint 23) — and carries the request ip into the audit row.
 *
 * Closing cancels every bid on the spot and re-bills the listings that held
 * them, inside the same transaction, through the same settle every owner
 * action ends with; PayPal being unconfigured is a "not-configured" change,
 * not a failure.
 */

export interface AdminSpotState {
  status: "idle" | "done" | "error";
  message?: string;
  /** The spot the message is about, so a table of forms shows it in the right row. */
  key?: string;
}

const GENERIC = "That did not work. Reload the table and try again.";

function parseKey(raw: string): SpotKey | null {
  const parts = raw.split(":");
  if (parts.length !== 3) return null;
  const [areaKind, areaId, category] = parts as [string, string, string];
  if (areaKind !== "city" && areaKind !== "region") return null;
  if (areaKind === "city" ? !isUuid(areaId) : !/^[a-z0-9-]{1,120}$/.test(areaId)) return null;
  if (category !== "-" && !isUuid(category)) return null;
  return { areaKind, areaId, categoryId: category === "-" ? null : category };
}

async function run(
  form: FormData,
  act: (tx: TestDb, viewer: Awaited<ReturnType<typeof requireAdmin>>, key: SpotKey, ip: string | null) => Promise<AdminSpotResult>,
  done: string,
  settle: boolean,
): Promise<AdminSpotState> {
  const viewer = await requireAdmin();
  const raw = String(form.get("key") ?? "").trim();
  const key = parseKey(raw);
  if (key === null) return { status: "error", message: GENERIC };
  const ip = clientIp(await headers());
  const client = getPayPalClient();
  let result: AdminSpotResult;
  let paths: string[] = [];
  try {
    result = await db.transaction(async (tx) => {
      const handle = tx as unknown as TestDb;
      const r = await act(handle, viewer, key, ip);
      if (r.outcome !== "done") return r;
      paths = [...r.paths];
      if (settle) {
        const settled = await settleSpots(handle, [r.spotId], { client }, r.listingIds);
        paths = [...new Set([...paths, ...settled.paths])];
      }
      return r;
    });
  } catch (e) {
    console.error("[spots] admin action failed:", e);
    return { status: "error", key: raw, message: "We could not reach PayPal to stop the charges. Nothing was changed; try again in a few minutes." };
  }
  if (result.outcome !== "done") return { status: "error", key: raw, message: GENERIC };
  revalidateListingPaths(paths);
  revalidatePath("/admin/spots");
  return { status: "done", key: raw, message: done };
}

export async function closeSpotAction(_prev: AdminSpotState, form: FormData): Promise<AdminSpotState> {
  return run(form, (tx, viewer, key, ip) => closeSpot(tx, viewer, key, { ip }), "Spot closed; its bids are cancelled and billing stops.", true);
}

export async function openSpotAction(_prev: AdminSpotState, form: FormData): Promise<AdminSpotState> {
  return run(form, (tx, viewer, key, ip) => openSpot(tx, viewer, key, { ip }), "Spot open to bidding.", false);
}

export async function setSpotFloorAction(_prev: AdminSpotState, form: FormData): Promise<AdminSpotState> {
  const raw = String(form.get("floor") ?? "").trim();
  const units = /^\d{1,6}$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isInteger(units) || units <= 0) {
    return { status: "error", key: String(form.get("key") ?? ""), message: "The floor is a whole monthly amount, at least 1." };
  }
  return run(
    form,
    (tx, viewer, key, ip) => setSpotFloor(tx, viewer, key, { floorCents: units * UNIT_CENTS, ip }),
    "Floor saved. Existing bids keep their place; new bids must clear it.",
    false,
  );
}
