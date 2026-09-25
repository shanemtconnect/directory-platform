"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db/client";
import { requireAdmin } from "@/lib/auth/viewer";
import { clientIp } from "@/lib/spam/client-ip";
import { neighbourhoodsEnabled, parseNeighbourhoodCsv, type CsvProblem } from "@/lib/geo/neighbourhoods";
import {
  enqueueNeighbourhoodAssign,
  importNeighbourhoods,
  setNeighbourhoodPublished,
} from "@/lib/db/queries/neighbourhoods";
import { revalidateListingPaths } from "@/lib/revalidate/listing";
import type { TestDb } from "@/lib/db/types";

/**
 * The three things an admin does to neighbourhoods (Task 52): import a CSV,
 * publish or unpublish one, and queue an assignment run.
 *
 * Each calls `requireAdmin()` first — the layout gates the page, not the
 * endpoint — and refuses outright with the module off, because a server
 * action is reachable whether or not a page links it. The query functions
 * write the rows and the audit rows on one transaction.
 */

export interface NeighbourhoodsActionState {
  status: "idle" | "done" | "error";
  message?: string;
  /** Rows the import skipped, by line. */
  problems?: CsvProblem[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Not exported: a "use server" module may export async functions only.
const MAX_UPLOAD_BYTES = 512 * 1024;
const OFF = "Neighbourhoods are off on this site.";
const ADMIN_PATH = "/admin/neighbourhoods";

/** The uploaded file if there is one, else the pasted text. */
async function csvText(form: FormData): Promise<string | { error: string }> {
  const file = form.get("file");
  if (file instanceof File && file.size > 0) {
    if (file.size > MAX_UPLOAD_BYTES) return { error: "That file is too large; split it into smaller ones." };
    return file.text();
  }
  const pasted = form.get("csv");
  const text = typeof pasted === "string" ? pasted : "";
  if (text.trim() === "") return { error: "Choose a CSV file or paste its contents." };
  if (text.length > MAX_UPLOAD_BYTES) return { error: "That is too much to paste at once; split it." };
  return text;
}

export async function importNeighbourhoodsAction(
  _prev: NeighbourhoodsActionState,
  form: FormData,
): Promise<NeighbourhoodsActionState> {
  const viewer = await requireAdmin();
  if (!neighbourhoodsEnabled()) return { status: "error", message: OFF };

  const text = await csvText(form);
  if (typeof text !== "string") return { status: "error", message: text.error };

  const parsed = parseNeighbourhoodCsv(text);
  const headerProblem = parsed.errors.find((e) => e.line === 1);
  if (headerProblem) return { status: "error", message: headerProblem.message };

  const ip = clientIp(await headers());
  const outcome = await db.transaction((tx) =>
    importNeighbourhoods(tx as unknown as TestDb, viewer, parsed.rows, { ip }),
  );
  revalidatePath(ADMIN_PATH);
  // Committed now: the town pages and neighbourhood pages the upload touched
  // (a renamed neighbourhood's H1, breadcrumb and town-list entry).
  revalidateListingPaths(outcome.revalidate);

  const problems = [...parsed.errors, ...outcome.skipped].sort((a, b) => a.line - b.line);
  return {
    status: "done",
    message:
      `${outcome.created} created, ${outcome.updated} updated, ${problems.length} skipped. ` +
      "Press \"Assign listings now\" to fill them, or wait for tonight's run.",
    problems,
  };
}

export async function setNeighbourhoodPublishedAction(
  _prev: NeighbourhoodsActionState,
  form: FormData,
): Promise<NeighbourhoodsActionState> {
  const viewer = await requireAdmin();
  if (!neighbourhoodsEnabled()) return { status: "error", message: OFF };

  const areaId = form.get("areaId");
  if (typeof areaId !== "string" || !UUID.test(areaId)) {
    return { status: "error", message: "That neighbourhood is not there any more. Reload the page." };
  }
  const published = form.get("published") === "true";
  const ip = clientIp(await headers());

  const result = await db.transaction((tx) =>
    setNeighbourhoodPublished(tx as unknown as TestDb, viewer, areaId, published, { ip }),
  );
  if (!result.ok) return { status: "error", message: "That neighbourhood is not there any more. Reload the page." };

  revalidatePath(ADMIN_PATH);
  // The town page's list and the neighbourhood page itself.
  revalidatePath(`/${result.citySlug}`);
  revalidatePath(`/${result.citySlug}/${result.slug}`);
  return { status: "done", message: published ? "Published." : "Unpublished." };
}

export async function assignNeighbourhoodsNowAction(
  _prev: NeighbourhoodsActionState,
  _form: FormData,
): Promise<NeighbourhoodsActionState> {
  const viewer = await requireAdmin();
  if (!neighbourhoodsEnabled()) return { status: "error", message: OFF };

  const ip = clientIp(await headers());
  await db.transaction((tx) => enqueueNeighbourhoodAssign(tx as unknown as TestDb, viewer, { ip }));
  return {
    status: "done",
    message: "Queued. The worker assigns every listing within a minute; reload to see the counts.",
  };
}
