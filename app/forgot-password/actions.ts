"use server";

import { createHash } from "node:crypto";
import { headers } from "next/headers";
import { getAuth } from "@/lib/auth/server";
import { rateLimit } from "@/lib/spam/rate-limit";
import {
  FORGOT_PASSWORD_EMAIL_RATE_LIMIT,
  FORGOT_PASSWORD_RATE_LIMIT,
  limitPublicWrite,
} from "@/lib/spam/write-limit";

/**
 * "Send me a reset link."
 *
 * A server action rather than a call to `authClient.requestPasswordReset` from
 * the browser, for two reasons. It works with JavaScript off — the one form on
 * the site a person reaches when something has already gone wrong for them is
 * the worst place to require a working bundle. And it is the only way to put
 * OUR rate limit in front of it: the client call would go through
 * app/api/auth/[...all], whose counter is shared with sign-in, so a locked-out
 * person burning their sign-in budget would find the escape hatch locked too.
 *
 * The reply never varies with whether the address is registered. Better Auth's
 * own endpoint is careful about this (it burns a token generation and a dummy
 * lookup for an unknown address, so the timing matches); saying "no such
 * account" here would hand back the account-enumeration oracle it went to that
 * trouble to close.
 *
 * Two counters, not one. Per connection, so a single client cannot lean on the
 * form; and per address, so a client rotating connections cannot point it at
 * one inbox — each request past the first would otherwise mint another live
 * token for that account. Only the connection budget reports itself: an
 * address that is over budget gets the ordinary "sent" reply, because "this
 * address has been asked about too often" is an answer about the address.
 */

export interface ForgotPasswordState {
  status: "idle" | "sent" | "error";
  message?: string;
}

/** The same permissive shape the enquiry form uses: delivery is the real test. */
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * One sentence, whatever happened. It is deliberately not "we have sent you an
 * email" — that is a claim we cannot make about an address we may not hold.
 */
const SENT =
  "If that address has an account, a link to set a new password is on its way. " +
  "It works once, and for an hour.";

export async function requestPasswordResetAction(
  _prev: ForgotPasswordState,
  form: FormData,
): Promise<ForgotPasswordState> {
  const email = String(form.get("email") ?? "").replace(/[\r\n]+/g, " ").trim();

  // A malformed address is a typo, not an enumeration attempt: there is no
  // account it could match either way, so saying so leaks nothing and saves
  // somebody waiting for an email that was never going anywhere.
  if (!EMAIL.test(email) || email.length > 254) {
    return { status: "error", message: "Please give a valid email address." };
  }

  const requestHeaders = await headers();
  const limit = await limitPublicWrite("forgot-password", requestHeaders, FORGOT_PASSWORD_RATE_LIMIT);
  if (!limit.allowed) {
    return {
      status: "error",
      message: `Too many requests from this connection. Please try again in ${Math.ceil(limit.retryAfterSeconds / 60)} minutes.`,
    };
  }

  // Hashed so the Redis key holds no address. Lowercased first: Better Auth
  // matches the address case-insensitively, so `Sam@` and `sam@` are one inbox.
  const emailKey = createHash("sha256").update(email.toLowerCase()).digest("hex");
  const perEmail = await rateLimit(`forgot-password:email:${emailKey}`, FORGOT_PASSWORD_EMAIL_RATE_LIMIT);
  if (!perEmail.allowed) {
    // Same sentence as success, and no token minted. See the note above.
    return { status: "sent", message: SENT };
  }

  try {
    await getAuth().api.requestPasswordReset({
      body: { email },
      headers: requestHeaders,
    });
  } catch {
    // Swallowed on purpose. Better Auth answers an unknown address with a
    // success, so anything thrown here is OUR problem — a database blip, a
    // queue write that failed — and surfacing it as a different reply for
    // some addresses and not others is the leak all of the above avoids.
    // The queue is what makes this safe to ignore: the email had not been
    // sent yet either way.
  }

  return { status: "sent", message: SENT };
}
