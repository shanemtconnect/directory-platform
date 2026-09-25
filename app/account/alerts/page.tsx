import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { siteConfig } from "@/config/site.config";
import { db } from "@/lib/db/client";
import { currentViewer } from "@/lib/auth/viewer";
import { guardFeature } from "@/lib/features/guard";
import { listSavedSearches } from "@/lib/db/queries/saved-searches";
import { deleteSavedSearchAction, setSavedSearchFrequencyAction } from "@/lib/actions/saved-searches";
import { savedSearchPath } from "@/lib/alerts/paths";
import { UnverifiedEmailBanner } from "@/components/auth/UnverifiedEmailBanner";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";

export const metadata: Metadata = {
  title: "Your alerts",
  robots: { index: false, follow: false },
};

/**
 * /account/alerts — the saved searches (Task 54, flag `savedSearches`).
 *
 * A 404 with the flag off, like every optional route. Each search can be
 * opened, set to daily or weekly, or deleted; the forms are plain server
 * actions, so the page works without JavaScript. One that was switched off
 * from an email's unsubscribe link says so, and saving the same search again
 * from its page switches it back on.
 */
export default async function AlertsPage() {
  guardFeature("savedSearches");
  const viewer = await currentViewer();
  // The layout redirects too, but renders concurrently with this page.
  if (viewer.role === "public") redirect("/login?next=/account/alerts");

  const searches = await listSavedSearches(db, viewer);
  const date = (d: Date) =>
    d.toLocaleDateString(siteConfig.locale, { day: "numeric", month: "short", year: "numeric", timeZone: siteConfig.timezone });

  return (
    <main>
      <PageHeader
        title="Your alerts"
        back={{ href: "/account", label: "Back to your account", testId: "alerts-back" }}
        lede="Searches you saved. We email you what is new for each one, daily or weekly — never the same result twice."
      />

      <UnverifiedEmailBanner />

      {searches.length === 0 ? (
        <EmptyState
          title="No saved searches yet"
          testId="alerts-empty"
          action={{ href: "/search", label: `Search ${siteConfig.entity.plural}` }}
        >
          <p>Run a search and press &ldquo;Save this search&rdquo; to be told when something new matches it.</p>
        </EmptyState>
      ) : (
        <ul data-testid="saved-searches" className="dash-grid">
          {searches.map((s) => (
            <li key={s.id} className="card" data-testid="saved-search" data-id={s.id}>
              <h2 className="text-lg">
                <a href={savedSearchPath(s.kind, s.params)}>{s.label}</a>
              </h2>
              <p className="flex flex-wrap gap-1 text-sm text-muted">
                <span className="pill">{s.kind === "jobs" ? "Jobs" : siteConfig.entity.Plural}</span>
                {s.isActive ? (
                  <span className="pill pill-on">Emails on</span>
                ) : (
                  <span className="pill" data-testid="saved-search-off">Unsubscribed</span>
                )}
                <span>{s.lastSentAt ? `Last emailed ${date(s.lastSentAt)}` : "Not emailed yet"}</span>
              </p>
              <form action={setSavedSearchFrequencyAction} className="flex flex-wrap items-end gap-2">
                <input type="hidden" name="id" value={s.id} />
                <p className="mb-0">
                  <label htmlFor={`frequency-${s.id}`}>How often</label>
                  <select id={`frequency-${s.id}`} name="frequency" defaultValue={s.frequency}>
                    <option value="daily">Daily</option>
                    <option value="weekly">Weekly</option>
                  </select>
                </p>
                <button type="submit" className="btn btn-secondary" data-testid="saved-search-frequency">
                  Update
                </button>
              </form>
              <form action={deleteSavedSearchAction} className="mt-2">
                <input type="hidden" name="id" value={s.id} />
                <button type="submit" className="btn btn-secondary" data-testid="saved-search-delete">
                  Delete<span className="sr-only"> {s.label}</span>
                </button>
              </form>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
