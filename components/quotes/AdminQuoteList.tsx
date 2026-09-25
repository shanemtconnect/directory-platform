import { siteConfig } from "@/config/site.config";
import { flagQuoteSpam } from "@/lib/actions/quotes";
import type { AdminQuoteRequest } from "@/lib/db/queries/quotes";
import { EmptyState } from "@/components/ui/EmptyState";

/**
 * The console's view of the broadcast: read-only, plus one flag.
 *
 * A server component with a plain form per row — there is no race to
 * report here. Flagging is idempotent, and two admins flagging the same row
 * is one flag. Newest first is the query's doing.
 */

function when(value: Date): string {
  return new Intl.DateTimeFormat(siteConfig.locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: siteConfig.timezone,
  }).format(value);
}

/** A form action returns nothing; the result is the revalidated list. */
async function flag(form: FormData): Promise<void> {
  "use server";
  await flagQuoteSpam(form);
}

export function AdminQuoteList({ requests }: { requests: AdminQuoteRequest[] }) {
  if (requests.length === 0) {
    return (
      <EmptyState testId="no-quote-requests" title="No quote requests yet.">
        Requests from /get-quotes land here as they are sent.
      </EmptyState>
    );
  }

  return (
    <ul data-testid="quote-request-list" className="link-grid">
      {requests.map((r) => (
        <li key={r.id} className="card" data-testid="quote-request-row" data-spam={r.isSpam} data-status={r.status}>
          <p className="text-sm text-muted">
            <time dateTime={r.createdAt.toISOString()}>{when(r.createdAt)}</time>
            {" · "}{r.categoryName} in {r.cityName}
            {" · "}sent to {r.recipientCount}, won {r.wonCount}
            {r.isSpam && <strong> · Flagged as spam</strong>}
            {/* Task 56: nothing is sent until the requester clicks the link. */}
            {r.status === "pending" && <strong data-testid="quote-unconfirmed"> · Awaiting the requester&rsquo;s confirmation</strong>}
            {r.status === "expired" && <strong> · Never confirmed — not sent</strong>}
          </p>
          <p>
            <strong>{r.name ?? "No name given"}</strong>
            {r.email && <> · <a href={`mailto:${r.email}`}>{r.email}</a></>}
            {r.phone && <> · {r.phone}</>}
          </p>
          {r.message && <p className="whitespace-pre-line">{r.message}</p>}
          <form action={flag}>
            <input type="hidden" name="quoteRequestId" value={r.id} />
            <input type="hidden" name="isSpam" value={r.isSpam ? "false" : "true"} />
            <button type="submit" className="btn" data-testid="quote-spam-toggle">
              {r.isSpam ? "Not spam" : "Flag as spam"}
            </button>
          </form>
        </li>
      ))}
    </ul>
  );
}
