"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db/client";
import { currentViewer } from "@/lib/auth/viewer";
import { features } from "@/lib/features/flags";
import { stripCrlf } from "@/lib/actions/validation";
import {
  createSavedSearch,
  deleteSavedSearch,
  setSavedSearchFrequency,
} from "@/lib/db/queries/saved-searches";
import type { TestDb } from "@/lib/db/types";

/**
 * The save button on /search and /jobs, and the two forms on
 * /account/alerts (Task 54, flag `savedSearches`).
 *
 * The viewer is re-read here, not trusted from the page: the account layout
 * is not a boundary for an action, which can be POSTed to directly. Which
 * rows a person may touch is decided by the queries (their own profile's).
 *
 * `params` is the page's own query input, passed through opaque. It is only
 * checked for SHAPE — a small object of strings, one level of nesting for
 * the custom-field facets — because it is stored and later spread into a
 * query; which keys mean anything is the query's business.
 */

export interface SaveSearchState {
  ok: boolean;
  /** Signed out: the button turns into the sign-in link. */
  signIn?: boolean;
  message?: string;
}

const OFF: SaveSearchState = { ok: false, message: "That isn't available on this site." };
const BAD: SaveSearchState = { ok: false, message: "That search can't be saved." };
const MAX_PARAMS_JSON = 2000;
const MAX_LABEL = 120;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

function validParams(params: unknown): params is Record<string, unknown> {
  if (!isPlainObject(params)) return false;
  if (JSON.stringify(params).length > MAX_PARAMS_JSON) return false;
  return Object.values(params).every((v) =>
    v === undefined || typeof v === "string" ||
    (isPlainObject(v) && Object.values(v).every((inner) => inner === undefined || typeof inner === "string")),
  );
}

function kindAllowed(kind: unknown): kind is "listings" | "jobs" {
  if (kind === "listings") return true;
  // Only offered where the board exists.
  return kind === "jobs" && features.jobBoard;
}

export async function saveSearch(input: {
  kind: "listings" | "jobs";
  params: Record<string, unknown>;
  label: string;
}): Promise<SaveSearchState> {
  if (!features.savedSearches) return OFF;
  const viewer = await currentViewer();
  if (viewer.role === "public") return { ok: false, signIn: true, message: "Sign in to save this search." };
  if (!kindAllowed(input.kind)) return OFF;
  if (!validParams(input.params)) return BAD;

  const label = stripCrlf(String(input.label ?? "")).replace(/\s+/g, " ").trim().slice(0, MAX_LABEL) || "Your search";

  const result = await db.transaction(async (tx) =>
    createSavedSearch(tx as unknown as TestDb, viewer, { kind: input.kind, params: input.params, label }),
  );
  if (result.outcome === "limit") {
    return { ok: false, message: "You can save up to 10 searches. Delete one under your alerts to save this one." };
  }
  revalidatePath("/account/alerts");
  return { ok: true };
}

const FREQUENCIES = ["daily", "weekly"] as const;

export async function setSavedSearchFrequencyAction(form: FormData): Promise<void> {
  if (!features.savedSearches) return;
  const viewer = await currentViewer();
  if (viewer.role === "public") return;
  const id = String(form.get("id") ?? "");
  const frequency = String(form.get("frequency") ?? "");
  const valid = FREQUENCIES.find((f) => f === frequency);
  if (valid === undefined) return;
  await db.transaction(async (tx) => setSavedSearchFrequency(tx as unknown as TestDb, viewer, id, valid));
  revalidatePath("/account/alerts");
}

export async function deleteSavedSearchAction(form: FormData): Promise<void> {
  if (!features.savedSearches) return;
  const viewer = await currentViewer();
  if (viewer.role === "public") return;
  const id = String(form.get("id") ?? "");
  await db.transaction(async (tx) => deleteSavedSearch(tx as unknown as TestDb, viewer, id));
  revalidatePath("/account/alerts");
}
