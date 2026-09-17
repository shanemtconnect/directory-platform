"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db/client";
import { ensureProfile } from "@/lib/auth/profile";
import { currentViewer, requireAdmin } from "@/lib/auth/viewer";
import {
  attachClaimDocument,
  decideClaim,
  startDocumentClaim,
  startDomainClaim,
} from "@/lib/db/queries/claims";
import { notifyClaimDecided, notifyClaimLink, notifyClaimSubmitted } from "@/lib/email/notify";
import { stripCrlf } from "@/lib/actions/validation";
import { CLAIM_RATE_LIMIT, validateDocumentClaim, validateDomainClaim } from "@/lib/claims/form";
import {
  claimDocKey,
  claimDocsConfigured,
  isAllowedClaimDocType,
  presignClaimDocUpload,
} from "@/lib/media/claim-docs";
import { clientIp } from "@/lib/spam/client-ip";
import { limitPublicWrite, retryMessage } from "@/lib/spam/write-limit";
import type { Db } from "@/lib/db/client";

/**
 * The two ways a claim starts.
 *
 * Both re-read the session rather than trusting anything the form carried: a
 * server action is a public HTTP endpoint, and the only thing separating a
 * claim from a listing takeover is who the server thinks is asking.
 *
 * Neither ever returns the magic token. The token is written to the claim row
 * inside the transaction and mailed by the worker to the business's own
 * domain; putting it in an action's return value would hand it to whoever
 * submitted the form, which is precisely the person it is meant to test.
 */

export interface ClaimState {
  status: "idle" | "sent" | "error";
  message?: string;
  fieldErrors?: Record<string, string>;
}

/** The address the link went to, so the page can say where to look. */
export interface DomainClaimState extends ClaimState {
  sentTo?: string;
}

const GENERIC_ERROR = "Something went wrong. Please try again.";

function mismatchMessage(): string {
  return (
    "That address is not on the website this listing shows. Use an address at " +
    "the business's own domain, or send a document instead."
  );
}

export async function requestClaimLink(
  _prev: DomainClaimState,
  form: FormData,
): Promise<DomainClaimState> {
  const viewer = await currentViewer();
  if (viewer.role === "public") {
    return { status: "error", message: "Please sign in to claim a listing." };
  }

  const { values, errors } = validateDomainClaim(form);
  if (errors) {
    return {
      status: "error",
      fieldErrors: errors,
      message: errors.listingId ? GENERIC_ERROR : undefined,
    };
  }

  const requestHeaders = await headers();
  // After validation, so a mistyped address does not cost one of the five.
  const limit = await limitPublicWrite("claim", requestHeaders, CLAIM_RATE_LIMIT);
  if (!limit.allowed) return { status: "error", message: retryMessage(limit) };

  const ip = clientIp(requestHeaders);
  const userAgent = requestHeaders.get("user-agent");

  const result = await db.transaction(async (tx) => {
    const handle = tx as unknown as Db;
    const profile = await ensureProfile(handle, viewer);
    const started = await startDomainClaim(handle, viewer, {
      listingId: values.listingId,
      profileId: profile.id,
      businessEmail: values.businessEmail,
      claimantName: values.claimantName,
      roleAtBusiness: values.roleAtBusiness,
      ip,
      userAgent,
    });
    // Enqueued inside the same transaction that wrote the token: no email for
    // a claim that rolled back, and no lost email for one that did not.
    if (started.outcome === "sent") await notifyClaimLink(handle, viewer, started.claimId);
    return started;
  });

  switch (result.outcome) {
    case "sent":
      return { status: "sent", sentTo: result.email };
    case "domain-mismatch":
      return { status: "error", fieldErrors: { businessEmail: mismatchMessage() } };
    case "already-claimed":
      return { status: "error", message: "Somebody has already claimed this listing." };
    case "unknown-listing":
      return { status: "error", message: "That listing is no longer available." };
  }
}

export interface PreparedUpload {
  ok: true;
  claimId: string;
  key: string;
  url: string;
  fields: Record<string, string>;
}

export type PrepareResult = PreparedUpload | { ok: false; message: string };

/**
 * Opens the claim and signs the browser's upload.
 *
 * The claim row is written BEFORE the object exists rather than after. An
 * abandoned upload then leaves a row an admin can see and the purge job can
 * clear; the other order leaves a document in a private bucket that nothing
 * points at, which nothing would ever delete.
 */
export async function prepareClaimDocument(input: {
  listingId: string;
  claimantName: string;
  roleAtBusiness: string;
  evidenceNotes: string;
  contentType: string;
}): Promise<PrepareResult> {
  const viewer = await currentViewer();
  if (viewer.role === "public") return { ok: false, message: "Please sign in to claim a listing." };

  // The rung is hidden when storage is unconfigured; this is the server side
  // of the same statement, because a hidden control is not a check.
  if (!claimDocsConfigured()) {
    return { ok: false, message: "Document uploads are not available on this site yet." };
  }
  if (!isAllowedClaimDocType(input.contentType)) {
    return { ok: false, message: "Please upload a PDF, JPEG or PNG." };
  }

  const form = new FormData();
  form.set("listingId", input.listingId);
  form.set("claimantName", input.claimantName);
  form.set("roleAtBusiness", input.roleAtBusiness);
  form.set("evidenceNotes", input.evidenceNotes);
  const { values, errors } = validateDocumentClaim(form);
  if (errors) {
    return { ok: false, message: errors.claimantName ?? errors.evidenceNotes ?? GENERIC_ERROR };
  }

  const requestHeaders = await headers();
  const limit = await limitPublicWrite("claim", requestHeaders, CLAIM_RATE_LIMIT);
  if (!limit.allowed) return { ok: false, message: retryMessage(limit) };

  const ip = clientIp(requestHeaders);
  const userAgent = requestHeaders.get("user-agent");

  const started = await db.transaction(async (tx) => {
    const handle = tx as unknown as Db;
    const profile = await ensureProfile(handle, viewer);
    return startDocumentClaim(handle, viewer, {
      listingId: values.listingId,
      profileId: profile.id,
      claimantName: values.claimantName,
      roleAtBusiness: values.roleAtBusiness,
      evidenceNotes: values.evidenceNotes,
      ip,
      userAgent,
    });
  });

  if (started.outcome === "already-claimed") {
    return { ok: false, message: "Somebody has already claimed this listing." };
  }
  if (started.outcome === "unknown-listing") {
    return { ok: false, message: "That listing is no longer available." };
  }

  const key = claimDocKey(started.claimId, input.contentType);
  try {
    const signed = await presignClaimDocUpload(key, input.contentType);
    return { ok: true, claimId: started.claimId, key, url: signed.url, fields: signed.fields };
  } catch {
    // Never the underlying message: it names the bucket and the account.
    return { ok: false, message: "We could not start the upload. Please try again." };
  }
}

/**
 * Records where the document landed, once the browser's POST to R2 succeeded.
 * Scoped to the signed-in user's own open claim inside the query.
 */
export async function confirmClaimDocument(input: {
  claimId: string;
  key: string;
}): Promise<{ ok: boolean; message?: string }> {
  const viewer = await currentViewer();
  if (viewer.role === "public") return { ok: false, message: "Please sign in to claim a listing." };

  // The key travels through the browser, so it is checked rather than trusted.
  // Scoping alone would still let a claimant point their own claim at a key
  // under somebody else's, and an admin would then be shown the wrong document.
  if (!input.key.startsWith(`claims/${input.claimId}/`)) {
    return { ok: false, message: GENERIC_ERROR };
  }

  const ip = clientIp(await headers());

  const attached = await db.transaction(async (tx) => {
    const handle = tx as unknown as Db;
    const profile = await ensureProfile(handle, viewer);
    const ok = await attachClaimDocument(handle, viewer, {
      claimId: input.claimId,
      profileId: profile.id,
      path: input.key,
      ip,
    });
    if (ok) await notifyClaimSubmitted(handle, viewer, input.claimId);
    return ok;
  });

  if (!attached) return { ok: false, message: GENERIC_ERROR };
  return { ok: true };
}

/* ------------------------------------------------------------------- admin */

export interface DecisionState {
  status: "idle" | "done" | "error";
  message?: string;
}

/**
 * Approve or reject, from `/admin/claims/[id]`.
 *
 * `requireAdmin()` here as well as in the layout, because the layout is not a
 * security boundary for actions: a server action is a POST endpoint anyone can
 * call directly, and it never renders through the layout that guards the page.
 */
export async function decideClaimAction(
  _prev: DecisionState,
  form: FormData,
): Promise<DecisionState> {
  const viewer = await requireAdmin();

  const claimId = String(form.get("claimId") ?? "");
  const decision = String(form.get("decision") ?? "");
  if (decision !== "approved" && decision !== "rejected") {
    return { status: "error", message: GENERIC_ERROR };
  }
  const reason = stripCrlf(String(form.get("reason") ?? "")).trim().slice(0, 500);

  const requestHeaders = await headers();
  const ip = clientIp(requestHeaders);

  const result = await db.transaction(async (tx) => {
    const handle = tx as unknown as Db;
    const profile = await ensureProfile(handle, viewer);
    const decided = await decideClaim(handle, viewer, {
      claimId, decision, reason: reason || null, actorProfileId: profile.id, ip,
    });
    // Inside the transaction, so a rolled-back decision sends no email.
    if (decided.outcome === "decided") await notifyClaimDecided(handle, viewer, claimId);
    return decided;
  });

  switch (result.outcome) {
    case "decided":
      // The public page states who owns the listing, and it is ISR-cached.
      revalidatePath(result.listingPath);
      revalidatePath("/admin/claims");
      return { status: "done" };
    case "reason-required":
      return { status: "error", message: "Please say why, so the claimant is told something useful." };
    case "already-decided":
      return { status: "error", message: "That claim has already been decided." };
    case "unknown":
      return { status: "error", message: "That claim could not be found." };
  }
}
