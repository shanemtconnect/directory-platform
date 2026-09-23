"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/lib/db/client";
import { currentViewer, requireAdmin } from "@/lib/auth/viewer";
import { ensureProfile } from "@/lib/auth/profile";
import { features } from "@/lib/features/flags";
import { clientIp } from "@/lib/spam/client-ip";
import { isHoneypotTripped, verifyTurnstile } from "@/lib/spam/turnstile";
import { JOB_APPLY_RATE_LIMIT, JOB_POST_RATE_LIMIT, limitPublicWrite } from "@/lib/spam/write-limit";
import { getPayPalOrdersClient, jobOrderUrls } from "@/lib/billing/orders";
import {
  approveJob,
  attachJobOrder,
  createJob,
  jobPaths,
  recordJobApply,
  rejectJob,
} from "@/lib/db/queries/job-board";
import { revalidateListingPaths } from "@/lib/revalidate/listing";
import { validateJobForm } from "@/lib/jobs/validate";
import { isUuid } from "@/lib/actions/validation";
import type { TestDb } from "@/lib/db/types";

/**
 * The jobs board's writes (Task 49).
 *
 * Posting follows the submission form's gate order exactly — honeypot,
 * validate, rate limit, Turnstile — and for the same reasons: the Turnstile
 * token is single-use and the budget is three a DAY, so neither may be spent
 * on a form that fails on a typo. Every action here 404s when the flag is
 * off: a server action is an endpoint, and `guardFeature` on the page is
 * not a boundary for it.
 *
 * Money: a post that owes a payment creates its PayPal order INSIDE the
 * transaction that creates the row, so a failed create rolls the row back
 * with it, and the buyer is sent to PayPal only once both have committed.
 */

export const JOB_THANKS_PATH = "/post-a-job/thanks";

export interface PostJobState {
  status: "idle" | "error";
  message?: string;
  fieldErrors?: Record<string, string>;
}

function assertFlag(): void {
  if (!features.jobBoard) throw new Error("NOT_FOUND");
}

export async function postJob(_prev: PostJobState, form: FormData): Promise<PostJobState> {
  assertFlag();

  // Silent success for the honeypot: a bot told it was caught learns to
  // stop filling that field.
  if (isHoneypotTripped(form.get("company_website"))) redirect(JOB_THANKS_PATH);

  const { values, errors } = validateJobForm(form);
  if (errors) {
    return { status: "error", fieldErrors: errors, message: "Please check the fields marked below." };
  }

  const requestHeaders = await headers();
  const ip = clientIp(requestHeaders);

  const limit = await limitPublicWrite("post-job", requestHeaders, JOB_POST_RATE_LIMIT);
  if (!limit.allowed) {
    return {
      status: "error",
      message: `Too many posts from this connection. Please try again in ${Math.ceil(limit.retryAfterSeconds / 3600)} hours.`,
    };
  }

  const turnstile = await verifyTurnstile(
    (form.get("cf-turnstile-response") as string | null) ?? null,
    ip ?? undefined,
  );
  if (!turnstile.ok) {
    return { status: "error", message: "We couldn't verify that you're human. Please try again." };
  }

  const viewer = await currentViewer();
  let posterProfileId: string | null = null;
  if (values.listingId !== null) {
    // A free post names a listing; only a signed-in owner can. The query
    // checks ownership and Verified — this only resolves who is asking.
    if (viewer.role === "public") {
      return { status: "error", fieldErrors: { listingId: "Please sign in to post on behalf of your listing." } };
    }
    posterProfileId = (await ensureProfile(db, viewer)).id;
  } else if (viewer.role !== "public") {
    posterProfileId = (await ensureProfile(db, viewer)).id;
  }

  const client = getPayPalOrdersClient();

  const result = await db.transaction(async (tx) => {
    const handle = tx as unknown as TestDb;
    const created = await createJob(handle, viewer, { ...values, posterProfileId, ip });
    if (created.outcome !== "created") return created;
    if (created.free) return { outcome: "free" as const };

    // Owed. No PayPal means no way to take the money: the row goes back with
    // the transaction rather than sitting forever as "pending payment".
    if (client === null) return { outcome: "not-configured" as const };

    const order = await client.createOrder({
      customId: created.jobId,
      description: `Job post: ${values.title}`,
      ...jobOrderUrls(),
    });
    await attachJobOrder(handle, viewer, { jobId: created.jobId, providerOrderId: order.id });
    return { outcome: "pay" as const, approveUrl: order.approveUrl };
  });

  switch (result.outcome) {
    case "unknown-city":
      return { status: "error", fieldErrors: { cityId: "Please choose a town." } };
    case "unknown-category":
      return { status: "error", fieldErrors: { categoryId: "Please choose a category." } };
    case "not-verified-listing":
      return {
        status: "error",
        fieldErrors: { listingId: "Only the owner of a Verified listing can post free. Leave this blank to post as a paid job." },
      };
    case "not-configured":
      return { status: "error", message: "Card payments are not set up on this site yet, so paid posts cannot be taken. Please try again later." };
    case "free":
      redirect(JOB_THANKS_PATH);
    // eslint-disable-next-line no-fallthrough -- redirect() never returns
    case "pay":
      if (result.approveUrl === null) {
        return { status: "error", message: "PayPal did not offer a payment page. Please try again." };
      }
      redirect(result.approveUrl);
  }
}

/**
 * Counts a press on Apply. Fire-and-forget from the link's onClick: the
 * visitor is already leaving for the mailto: or the employer's site, and no
 * answer here changes that.
 */
export async function recordApplyClick(jobId: string): Promise<void> {
  assertFlag();
  if (!isUuid(jobId)) return;
  const limit = await limitPublicWrite("job-apply", await headers(), JOB_APPLY_RATE_LIMIT);
  if (!limit.allowed) return;
  await recordJobApply(db as never, { role: "public" }, jobId);
}

/* ------------------------------------------------------------------- admin */

const QUEUE = "/admin/jobs";

function readId(form: FormData, field: string): string | null {
  const value = form.get(field);
  return typeof value === "string" && isUuid(value) ? value : null;
}

/** The board and the job's pages are ISR; a decision changes what they show. */
function revalidateJob(paths: readonly string[]): void {
  revalidateListingPaths(paths);
  revalidatePath(QUEUE);
}

export async function approveJobAction(form: FormData): Promise<void> {
  assertFlag();
  const viewer = await requireAdmin();
  const jobId = readId(form, "jobId");
  if (jobId === null) redirect(QUEUE);

  const ip = clientIp(await headers());
  const outcome = await db.transaction(async (tx) => {
    const handle = tx as unknown as TestDb;
    const paths = await jobPaths(handle, viewer, jobId);
    const result = await approveJob(handle, viewer, jobId, { ip });
    return { result, paths };
  });

  if (outcome.result.outcome === "approved") revalidateJob(outcome.paths);
  redirect(QUEUE);
}

export interface RejectJobState {
  status: "idle" | "error";
  message?: string;
}

export async function rejectJobAction(_prev: RejectJobState, form: FormData): Promise<RejectJobState> {
  assertFlag();
  const viewer = await requireAdmin();
  const jobId = readId(form, "jobId");
  if (jobId === null) return { status: "error", message: "That post could not be found." };
  const reason = String(form.get("reason") ?? "").trim();

  const ip = clientIp(await headers());
  const result = await db.transaction(async (tx) =>
    rejectJob(tx as unknown as TestDb, viewer, jobId, { ip, reason }),
  );

  if (result.outcome === "reason-required") {
    return { status: "error", message: "Please give the poster a reason." };
  }
  revalidatePath(QUEUE);
  redirect(QUEUE);
}
