"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { db } from "@/lib/db/client";
import {
  createSubmission,
  findSubmissionDuplicate,
} from "@/lib/db/queries/submissions";
import { clientIp, rateLimitSubject } from "@/lib/spam/client-ip";
import { rateLimit } from "@/lib/spam/rate-limit";
import { isHoneypotTripped, verifyTurnstile } from "@/lib/spam/turnstile";
import type { TestDb } from "@/test/db";
import { validateSubmission } from "./validation";

export interface SubmitListingState {
  status: "idle" | "duplicate" | "error";
  message?: string;
  fieldErrors?: Record<string, string>;
  /** Set with status 'duplicate'. The route offers a claim instead of a second row. */
  existing?: { name: string; claimPath: string };
}

/**
 * Public listing submission. No account required: a login wall in front of an
 * unpaid, unclaimed listing costs more submissions than the spam it stops, so
 * the defence is Turnstile plus a honeypot plus a hard per-IP cap instead.
 */
export async function submitListing(
  _prev: SubmitListingState,
  form: FormData,
): Promise<SubmitListingState> {
  // Silent success for the honeypot: telling a bot it was caught just teaches
  // the operator to stop filling that field.
  if (isHoneypotTripped(form.get("company_website"))) {
    redirect("/add-listing/thanks");
  }

  // Validate before spending anything. The Turnstile token is single-use and
  // the rate limit is three an hour: burning either on a form that fails on a
  // postcode typo is how a legitimate submitter ends up locked out of a retry.
  const { values, errors } = validateSubmission(form);
  if (errors) {
    return { status: "error", fieldErrors: errors, message: "Please check the fields marked below." };
  }

  const ip = clientIp(await headers());

  // Three an hour. A person listing their own business does it once; three is
  // room for a genuine retry and nothing like enough for a spam run.
  const limit = await rateLimit(`submit-listing:${rateLimitSubject(ip)}`, {
    limit: 3,
    windowSeconds: 3600,
  });
  if (!limit.allowed) {
    return {
      status: "error",
      message: `Too many submissions from this connection. Please try again in ${Math.ceil(limit.retryAfterSeconds / 60)} minutes.`,
    };
  }

  const turnstile = await verifyTurnstile(
    (form.get("cf-turnstile-response") as string | null) ?? null,
    ip ?? undefined,
  );
  if (!turnstile.ok) {
    return { status: "error", message: "We couldn't verify that you're human. Please try again." };
  }

  const result = await db.transaction(async (tx) => {
    // Same cast the test harness uses: a transaction handle and the root
    // client expose the same query surface to lib/db/queries.
    const handle = tx as unknown as TestDb;

    const duplicate = await findSubmissionDuplicate(handle, values);
    if (duplicate) return { kind: "duplicate" as const, duplicate };

    return {
      kind: "saved" as const,
      saved: await createSubmission(handle, { ...values, ip }),
    };
  });

  if (result.kind === "duplicate") {
    return {
      status: "duplicate",
      existing: {
        name: result.duplicate.name,
        claimPath: `/claim/${result.duplicate.slug}`,
      },
    };
  }

  if (result.saved.outcome === "unknown-category") {
    return { status: "error", fieldErrors: { categoryId: "Please choose a category." } };
  }

  // 'parked' and 'created' are the same event to the submitter: we have it and
  // an admin will look at it. The difference is only whether the town already
  // existed, which is our problem and not theirs.
  redirect("/add-listing/thanks");
}
