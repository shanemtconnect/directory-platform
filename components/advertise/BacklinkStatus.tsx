import type { OwnerBadgeStatus } from "@/lib/db/queries/badge-owner";

function when(date: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(date);
}

/**
 * Where the owner said the badge is, and what the last check found.
 *
 * Three states and nothing invented between them: nothing registered yet; a
 * page registered and not yet looked at; a page looked at, with the answer.
 * A check that found no link is stated as that, not softened — the boost the
 * link earns is only worth having if the absence of it is visible too.
 */
export function BacklinkStatus({ status }: { status: OwnerBadgeStatus }) {
  const { backlinkUrl, backlinkVerified, lastCheckedAt } = status;

  if (backlinkUrl === null) {
    return (
      <p data-testid="backlink-status" data-state="unregistered">
        You have not told us where the badge is yet. Once you have pasted it somewhere, put the
        page's address in the box below and we will go and look for the link.
      </p>
    );
  }

  return (
    <dl
      data-testid="backlink-status"
      data-state={lastCheckedAt === null ? "pending" : backlinkVerified ? "verified" : "missing"}
    >
      <dt>Registered page</dt>
      <dd>
        <a href={backlinkUrl} rel="noopener nofollow" data-testid="backlink-registered-url">
          {backlinkUrl}
        </a>
      </dd>
      <dt>Last check</dt>
      <dd>
        {lastCheckedAt === null ? (
          <>Not checked yet — it is in the queue for the next hourly run.</>
        ) : backlinkVerified ? (
          <>
            Link found, {when(lastCheckedAt)}. It counts towards your ranking while it stays
            up; we look again every week.
          </>
        ) : (
          <>
            No link to your listing was found on that page, {when(lastCheckedAt)}. Check the
            badge is there and that the link was not stripped out, then press &ldquo;check
            now&rdquo;. We try again daily either way.
          </>
        )}
      </dd>
    </dl>
  );
}
