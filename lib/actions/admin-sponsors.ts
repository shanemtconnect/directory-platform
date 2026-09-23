"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db/client";
import { requireAdmin } from "@/lib/auth/viewer";
import { clientIp } from "@/lib/spam/client-ip";
import {
  decideSponsorCampaign,
  type SponsorDecision,
  type SponsorDecisionResult,
} from "@/lib/db/queries/ads";
import { notifySponsorDecided } from "@/lib/email/notify";
import { isUuid } from "@/lib/actions/validation";
import type { TestDb } from "@/lib/db/types";

/**
 * The admin queue's buttons. Every one re-checks `requireAdmin()` — the
 * layout is not a security boundary for actions (constraint 23) — and
 * carries the request ip into the audit row.
 */
export interface SponsorQueueState {
  status: "idle" | "done" | "error";
  message?: string;
}

const GONE = "That campaign is not there any more. Reload the queue to see what is left.";

function message(result: SponsorDecisionResult): string | null {
  switch (result.outcome) {
    case "unknown":
      return GONE;
    case "not-allowed":
      return "That campaign is not in a state this can be done to. Reload the queue.";
    case "reason-required":
      return "Say why, in a sentence the advertiser can act on.";
    default:
      return null;
  }
}

/** Approve and reject are announced; pause, resume and end are the site's own business. */
const ANNOUNCED: readonly SponsorDecision[] = ["approve", "reject"];

async function decide(form: FormData, decision: SponsorDecision): Promise<SponsorQueueState> {
  const viewer = await requireAdmin();
  const campaignId = String(form.get("campaignId") ?? "").trim();
  if (!isUuid(campaignId)) return { status: "error", message: GONE };
  const ip = clientIp(await headers());
  const reason = String(form.get("reason") ?? "");
  const result = await db.transaction(async (tx) => {
    const handle = tx as unknown as TestDb;
    const decided = await decideSponsorCampaign(handle, viewer, campaignId, { decision, reason, ip });
    if (decided.outcome === "decided" && ANNOUNCED.includes(decision)) {
      await notifySponsorDecided(handle, viewer, campaignId);
    }
    return decided;
  });
  const failure = message(result);
  if (failure !== null) return { status: "error", message: failure };
  revalidatePath("/admin/sponsors");
  revalidatePath("/admin");
  return { status: "done" };
}

export async function approveSponsorAction(_prev: SponsorQueueState, form: FormData): Promise<SponsorQueueState> {
  return decide(form, "approve");
}
export async function rejectSponsorAction(_prev: SponsorQueueState, form: FormData): Promise<SponsorQueueState> {
  return decide(form, "reject");
}
export async function pauseSponsorAction(_prev: SponsorQueueState, form: FormData): Promise<SponsorQueueState> {
  return decide(form, "pause");
}
export async function resumeSponsorAction(_prev: SponsorQueueState, form: FormData): Promise<SponsorQueueState> {
  return decide(form, "resume");
}
export async function endSponsorAction(_prev: SponsorQueueState, form: FormData): Promise<SponsorQueueState> {
  return decide(form, "end");
}
