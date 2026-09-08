import { Resend } from "resend";

/**
 * The one place mail leaves the process.
 *
 * Two rules hold everything else together. First, this never throws: it is
 * called from a background job and, indirectly, from a request path, and a
 * dead mail provider must not turn a saved enquiry into an error page. Every
 * failure comes back as a value. Second, every HEADER field is stripped of CR
 * and LF before it goes near the provider — a recipient name or subject built
 * from a public form is otherwise a header-injection vector, and one embedded
 * newline is the difference between a subject line and an extra `Bcc:`.
 */

export interface EmailMessage {
  to: string | string[];
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
}

export type SendResult =
  | { sent: true; id: string }
  | { sent: false; reason: "not-configured" | "no-recipient" | "rejected"; error?: string };

/**
 * Removes the characters that end a header line, then collapses what is left.
 *
 * Deleting the newline outright would silently glue two words together; a
 * space keeps the text readable while making the injected header a harmless
 * continuation of the original value.
 */
export function stripHeader(value: string): string {
  return value.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}

let client: Resend | null = null;
let warned = false;

/** Test-only. Drops the memoised client so a changed key is picked up. */
export function resetEmailClient(): void {
  client = null;
  warned = false;
}

export async function sendEmail(message: EmailMessage): Promise<SendResult> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.EMAIL_FROM?.trim();
  if (!apiKey || !from) {
    // A local or preview environment legitimately has no mail credentials.
    // Once is enough: this is called per notification, and a line per enquiry
    // would bury the log it is meant to appear in.
    if (!warned) {
      warned = true;
      console.warn("[email] RESEND_API_KEY or EMAIL_FROM is unset — sending nothing");
    }
    return { sent: false, reason: "not-configured" };
  }

  const to = (Array.isArray(message.to) ? message.to : [message.to])
    .map(stripHeader)
    .filter((address) => address !== "");
  if (to.length === 0) return { sent: false, reason: "no-recipient" };

  client ??= new Resend(apiKey);

  try {
    const { data, error } = await client.emails.send({
      from: stripHeader(from),
      to,
      subject: stripHeader(message.subject),
      // Bodies are not headers. Their newlines are content and stay.
      html: message.html,
      text: message.text,
      ...(message.replyTo === undefined ? {} : { replyTo: stripHeader(message.replyTo) }),
    });
    if (error) return { sent: false, reason: "rejected", error: error.message };
    return { sent: true, id: data!.id };
  } catch (e) {
    return { sent: false, reason: "rejected", error: e instanceof Error ? e.message : String(e) };
  }
}
