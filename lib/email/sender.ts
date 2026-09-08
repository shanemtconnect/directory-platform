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

/**
 * The worker calls this from inside the transaction holding the notify
 * advisory lock, on one of ten pooled connections. A provider that accepts the
 * socket and then never answers would hold both until the container restarts,
 * and every notification behind it would simply stop.
 *
 * Resend 6.x takes only `query`, `headers` and `idempotencyKey` on
 * `emails.send`, so there is no AbortSignal to hand it; the race is the only
 * lever available. The underlying request is abandoned rather than cancelled,
 * which is the right trade: the job is retried, and a duplicate send is a far
 * smaller problem than a worker that has stopped.
 */
const SEND_TIMEOUT_MS = 10_000;

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`the mail provider did not answer in ${ms}ms`)), ms);
  });
  // Promise.race attaches a handler to both, so a late rejection from the
  // abandoned send is handled and never surfaces as an unhandled rejection.
  return Promise.race([work, expiry]).finally(() => clearTimeout(timer));
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

  try {
    // Inside the try: the constructor is the one line here that can throw, and
    // this function's contract is that it never does.
    client ??= new Resend(apiKey);

    const { data, error } = await withTimeout(client.emails.send({
      from: stripHeader(from),
      to,
      subject: stripHeader(message.subject),
      // Bodies are not headers. Their newlines are content and stay.
      html: message.html,
      text: message.text,
      ...(message.replyTo === undefined ? {} : { replyTo: stripHeader(message.replyTo) }),
    }), SEND_TIMEOUT_MS);
    if (error) return { sent: false, reason: "rejected", error: error.message };
    return { sent: true, id: data!.id };
  } catch (e) {
    return { sent: false, reason: "rejected", error: e instanceof Error ? e.message : String(e) };
  }
}
