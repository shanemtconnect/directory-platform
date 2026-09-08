"use server";

import { and, eq, sql } from "drizzle-orm";
import { headers } from "next/headers";
import { db } from "@/lib/db/client";
import { enquiries, listings } from "@/lib/db/schema";
import { rateLimit } from "@/lib/spam/rate-limit";
import { verifyTurnstile, isHoneypotTripped } from "@/lib/spam/turnstile";

export interface EnquiryState {
  status: "idle" | "sent" | "error";
  message?: string;
  fieldErrors?: Record<string, string>;
}

const MAX = { name: 120, email: 254, phone: 40, message: 2000 } as const;

function validate(form: FormData): { values?: {
  name: string; email: string; phone: string | null; message: string;
}; errors?: Record<string, string> } {
  const errors: Record<string, string> = {};
  const name = String(form.get("name") ?? "").trim();
  const email = String(form.get("email") ?? "").trim();
  const phone = String(form.get("phone") ?? "").trim();
  const message = String(form.get("message") ?? "").trim();

  if (name.length < 2) errors.name = "Please give your name.";
  if (name.length > MAX.name) errors.name = "That name is too long.";
  // Deliberately permissive: over-strict email regexes reject valid addresses,
  // and the address is verified by whether the reply arrives, not by us.
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) errors.email = "Please give a valid email address.";
  if (email.length > MAX.email) errors.email = "That email address is too long.";
  if (phone.length > MAX.phone) errors.phone = "That phone number is too long.";
  if (message.length < 10) errors.message = "Please write a little more.";
  if (message.length > MAX.message) errors.message = "Please keep it under 2000 characters.";

  if (Object.keys(errors).length > 0) return { errors };
  return { values: { name, email, phone: phone || null, message } };
}

export async function submitEnquiry(
  _prev: EnquiryState,
  form: FormData,
): Promise<EnquiryState> {
  const listingId = String(form.get("listingId") ?? "");
  if (!listingId) return { status: "error", message: "Something went wrong. Please try again." };

  // Silent success for the honeypot: telling a bot it was caught just teaches
  // the operator to stop filling that field.
  if (isHoneypotTripped(form.get("company_website"))) {
    return { status: "sent" };
  }

  const h = await headers();
  const ip = (h.get("x-forwarded-for") ?? "").split(",")[0]?.trim() || "unknown";

  const limit = await rateLimit(`enquiry:${ip}`, { limit: 5, windowSeconds: 3600 });
  if (!limit.allowed) {
    return {
      status: "error",
      message: `Too many enquiries from this connection. Please try again in ${Math.ceil(limit.retryAfterSeconds / 60)} minutes.`,
    };
  }

  const turnstile = await verifyTurnstile(
    (form.get("cf-turnstile-response") as string | null) ?? null,
    ip,
  );
  if (!turnstile.ok) {
    return { status: "error", message: "We couldn't verify that you're human. Please try again." };
  }

  const { values, errors } = validate(form);
  if (errors) return { status: "error", fieldErrors: errors };

  // Only published listings can receive an enquiry — the same gate the pillar
  // pages use. A pending or removed listing must not collect leads.
  const [target] = await db
    .select({ id: listings.id })
    .from(listings)
    .where(and(eq(listings.id, listingId), eq(listings.status, "published")))
    .limit(1);
  if (!target) return { status: "error", message: "That listing is no longer available." };

  await db.transaction(async (tx) => {
    await tx.insert(enquiries).values({
      listingId,
      name: values!.name,
      email: values!.email,
      phone: values!.phone,
      message: values!.message,
      ip,
    });
    await tx
      .update(listings)
      .set({ enquiryCount: sql`${listings.enquiryCount} + 1` })
      .where(eq(listings.id, listingId));
  });

  // Phase 3 sends the owner notification email; the enquiry is durable either way.
  return { status: "sent" };
}
