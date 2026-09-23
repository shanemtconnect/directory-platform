"use client";

import { useActionState } from "react";
import { siteConfig } from "@/config/site.config";
import { computeAwardsAction, revokeAwardAction, type AwardsActionState } from "@/lib/actions/admin-awards";
import { AWARDS_MIN_RATED_LISTINGS, type AdminAward, type AdminAwardYear } from "@/lib/db/queries/awards";
import { Notice } from "@/components/ui/Notice";
import { EmptyState } from "@/components/ui/EmptyState";
import { SubmitButton } from "@/components/ui/SubmitButton";

/**
 * The awards console (Task 50): "compute <year>", the years, and per year
 * every row with a revoke form.
 *
 * Client components for the same reason the other queues are: an outcome is
 * shown in place — "12 awards decided", "already revoked" — rather than by a
 * redirect that looks like success whatever happened.
 */

const INITIAL: AwardsActionState = { status: "idle" };

function when(value: Date): string {
  return new Intl.DateTimeFormat(siteConfig.locale, {
    dateStyle: "medium",
    timeZone: siteConfig.timezone,
  }).format(value);
}

function Outcome({ state, testId }: { state: AwardsActionState; testId: string }) {
  if (state.status === "error") {
    return <Notice variant="error" testId={`${testId}-error`}>{state.message}</Notice>;
  }
  if (state.status === "done") {
    return <Notice variant="success" testId={`${testId}-done`}>{state.message}</Notice>;
  }
  return null;
}

export function ComputeAwardsForm({ defaultYear }: { defaultYear: number }) {
  const [state, action, pending] = useActionState(computeAwardsAction, INITIAL);
  return (
    <section aria-labelledby="compute" className="card">
      <h2 id="compute" className="mt-0">Compute a year</h2>
      <p className="text-sm text-muted">
        Runs the method for the year you give: one winner per town and category with at least{" "}
        {AWARDS_MIN_RATED_LISTINGS} rated {siteConfig.entity.plural}. Safe to press twice — a decided
        slot is left alone. The worker does this itself on 1 January.
      </p>
      <Outcome state={state} testId="compute" />
      <form action={action} className="form-actions">
        <label htmlFor="award-year" className="text-sm font-semibold">Year</label>
        <input
          id="award-year"
          name="year"
          type="number"
          inputMode="numeric"
          min={2000}
          max={2199}
          defaultValue={defaultYear}
          required
          className="w-28"
          data-testid="compute-year"
        />
        <SubmitButton pending={pending} pendingLabel="Computing…" testId="compute-submit">
          Compute
        </SubmitButton>
      </form>
    </section>
  );
}

export function AwardYearsTable({ years }: { years: AdminAwardYear[] }) {
  if (years.length === 0) {
    return (
      <EmptyState title="No year has been computed yet." testId="awards-empty">
        <p>Compute one above, or wait for 1 January.</p>
      </EmptyState>
    );
  }
  return (
    <table className="table-cards" data-testid="award-years">
      <thead>
        <tr><th>Year</th><th>Winners</th><th>Revoked</th></tr>
      </thead>
      <tbody>
        {years.map((y) => (
          <tr key={y.year}>
            <td data-label="Year"><a href={`/admin/awards/${y.year}`}>{y.year}</a></td>
            <td data-label="Winners">{y.winners}</td>
            <td data-label="Revoked">{y.revoked}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function RevokeForm({ award }: { award: AdminAward }) {
  const [state, action, pending] = useActionState(revokeAwardAction, INITIAL);
  const done = state.status === "done";
  return (
    <>
      <Outcome state={state} testId={`revoke-${award.awardId}`} />
      {!done && (
        <form action={action} className="form-actions">
          <input type="hidden" name="awardId" value={award.awardId} />
          <label htmlFor={`reason-${award.awardId}`} className="sr-only">Reason</label>
          <input
            id={`reason-${award.awardId}`}
            name="reason"
            type="text"
            required
            maxLength={500}
            placeholder="Why — goes to the audit log"
            className="min-w-0 flex-1"
            data-testid="revoke-reason"
          />
          <SubmitButton pending={pending} pendingLabel="Revoking…" variant="secondary" testId="revoke-submit">
            Revoke
          </SubmitButton>
        </form>
      )}
    </>
  );
}

export function AwardRows({ year, rows }: { year: number; rows: AdminAward[] }) {
  if (rows.length === 0) {
    return (
      <EmptyState title={`Nothing was awarded for ${year}.`} testId="award-rows-empty">
        <p>No town and category had enough rated {siteConfig.entity.plural} when it was computed.</p>
      </EmptyState>
    );
  }
  return (
    <ul className="m-0 list-none p-0" data-testid="award-rows">
      {rows.map((a) => {
        const titleId = `award-${a.awardId}-title`;
        return (
          <li key={a.awardId} className="card mb-3" data-testid={`award-${a.awardId}`} data-revoked={a.revokedAt !== null}>
            <h2 className="mt-0 text-lg" id={titleId}>
              <a href={a.listingPath}>{a.listingName}</a>
            </h2>
            <p className="text-sm text-muted">
              <strong className="text-ink">{a.categoryName}</strong> · {a.cityName}
              {a.ratingAvg !== null && ` · ${a.ratingAvg} from ${a.ratingCount} reviews`}
              {a.listingStatus !== "published" && (
                <> · <span className="pill pill-danger">{a.listingStatus}</span></>
              )}
              {a.publishedAt !== null && ` · decided ${when(a.publishedAt)}`}
            </p>
            {a.revokedAt !== null ? (
              <p className="text-sm" data-testid="award-revoked">
                <span className="pill pill-danger">Revoked</span> {when(a.revokedAt)}
                {a.revokeReason !== null && ` — ${a.revokeReason}`}
              </p>
            ) : (
              <div className="action-bar" role="group" aria-labelledby={titleId}>
                <RevokeForm award={a} />
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
