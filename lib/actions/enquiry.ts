"use server";

import { and, eq, sql } from "drizzle-orm";
import { headers } from "next/headers";
import { db } from "@/lib/db/client";
import { enquiries, listings } from "@/lib/db/schema";
import { clientIp, rateLimitSubject } from "@/lib/spam/client-ip";
import { rateLimit } from "@/lib/spam/rate-limit";
import { verifyTurnstile, isHoneypotTripped } from "@/lib/spam/turnstile";
import { validateEnquiry } from "./validation";

export interface EnquiryState {
  status: "idle" | "sent" | "error";
  message?: string;
  fieldErrors?: Record<string, string>;
}

export async function submitEnquiry(
  _prev: EnquiryState,
  form: FormData,
): Promise<EnquiryState> {
  // Silent success for the honeypot: telling a bot it was caught just teaches
  // the operator to stop filling that field.
  if (isHoneypotTripped(form.get("company_website"))) {
    return { status: "sent" };
  }

  // Validation comes first, and that ordering is load-bearing. A Turnstile
  // token is single-use: spending it on a submission that then fails on a
  // typo leaves the visitor unable to retry without solving a new challenge.
  // Nor should a typo cost one of the five hourly attempts.
  const { values, errors } = validateEnquiry(form);
  if (errors) {
    return {
      status: "error",
      fieldErrors: errors,
      // listingId is a hidden field, so its error has nowhere to render.
      message: errors.listingId ? "Something went wrong. Please try again." : undefined,
    };
  }

  const ip = clientIp(await headers());
  const limit = await rateLimit(`enquiry:${rateLimitSubject(ip)}`, {
    limit: 5,
    windowSeconds: 3600,
  });
  if (!limit.allowed) {
    return {
      status: "error",
      message: `Too many enquiries from this connection. Please try again in ${Math.ceil(limit.retryAfterSeconds / 60)} minutes.`,
    };
  }

  const turnstile = await verifyTurnstile(
    (form.get("cf-turnstile-response") as string | null) ?? null,
    ip ?? undefined,
  );
  if (!turnstile.ok) {
    return { status: "error", message: "We couldn't verify that you're human. Please try again." };
  }

  // Only published listings can receive an enquiry — the same gate the pillar
  // pages use. A pending or removed listing must not collect leads.
  const [target] = await db
    .select({ id: listings.id })
    .from(listings)
    .where(and(eq(listings.id, values.listingId), eq(listings.status, "published")))
    .limit(1);
  if (!target) return { status: "error", message: "That listing is no longer available." };

  await db.transaction(async (tx) => {
    await tx.insert(enquiries).values({
      listingId: values.listingId,
      name: values.name,
      email: values.email,
      phone: values.phone,
      message: values.message,
      ip,
    });
    await tx
      .update(listings)
      .set({ enquiryCount: sql`${listings.enquiryCount} + 1` })
      .where(eq(listings.id, values.listingId));
  });

  // Phase 3 sends the owner notification email; the enquiry is durable either way.
  return { status: "sent" };
}
