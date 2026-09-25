"use client";

import { useActionState } from "react";
import {
  assignNeighbourhoodsNowAction,
  importNeighbourhoodsAction,
  setNeighbourhoodPublishedAction,
  type NeighbourhoodsActionState,
} from "@/lib/actions/admin-neighbourhoods";
import type { AdminNeighbourhood, AdminNeighbourhoodTown } from "@/lib/db/queries/neighbourhoods";
import { Notice } from "@/components/ui/Notice";
import { EmptyState } from "@/components/ui/EmptyState";
import { SubmitButton } from "@/components/ui/SubmitButton";

/**
 * The neighbourhoods console (Task 52): CSV import, "assign now", and per
 * town a table with a publish toggle on every row. Client components so each
 * outcome — "3 created, 1 skipped", the skipped lines — shows in place.
 */

const INITIAL: NeighbourhoodsActionState = { status: "idle" };

function Outcome({ state, testId }: { state: NeighbourhoodsActionState; testId: string }) {
  if (state.status === "error") {
    return <Notice variant="error" testId={`${testId}-error`}>{state.message}</Notice>;
  }
  if (state.status === "done") {
    return (
      <Notice variant="success" testId={`${testId}-done`}>
        {state.message}
        {state.problems && state.problems.length > 0 && (
          <ul className="mb-0 mt-2" data-testid={`${testId}-problems`}>
            {state.problems.map((p) => (
              <li key={`${p.line}-${p.message}`}>Line {p.line}: {p.message}</li>
            ))}
          </ul>
        )}
      </Notice>
    );
  }
  return null;
}

export function ImportNeighbourhoodsForm({ header, defaultRadiusKm }: { header: string; defaultRadiusKm: number }) {
  const [state, action, pending] = useActionState(importNeighbourhoodsAction, INITIAL);
  return (
    <section aria-labelledby="import" className="card">
      <h2 id="import" className="mt-0">Import</h2>
      <p className="text-sm text-muted">
        A CSV whose first line is exactly <code>{header}</code>. An empty slug is made from the name;
        an empty radius is {defaultRadiusKm} km. A row whose slug is already a category or a listing in
        that town is skipped and reported; a row for a neighbourhood the town already has updates it.
      </p>
      <Outcome state={state} testId="import" />
      <form action={action}>
        <p>
          <label htmlFor="neighbourhoods-file">CSV file</label>
          <input id="neighbourhoods-file" name="file" type="file" accept=".csv,text/csv" data-testid="import-file" />
        </p>
        <p>
          <label htmlFor="neighbourhoods-csv">Or paste it</label>
          <textarea id="neighbourhoods-csv" name="csv" rows={5} placeholder={header} data-testid="import-csv" />
        </p>
        <div className="form-actions">
          <SubmitButton pending={pending} pendingLabel="Importing…" testId="import-submit">
            Import
          </SubmitButton>
        </div>
      </form>
    </section>
  );
}

export function AssignNowForm() {
  const [state, action, pending] = useActionState(assignNeighbourhoodsNowAction, INITIAL);
  return (
    <section aria-labelledby="assign" className="card">
      <h2 id="assign" className="mt-0">Assign listings</h2>
      <p className="text-sm text-muted">
        Runs every night. Press this after an import to fill the new neighbourhoods straight away.
      </p>
      <Outcome state={state} testId="assign" />
      <form action={action} className="form-actions">
        <SubmitButton pending={pending} pendingLabel="Queueing…" variant="secondary" testId="assign-submit">
          Assign listings now
        </SubmitButton>
      </form>
    </section>
  );
}

function PublishToggle({ n }: { n: AdminNeighbourhood }) {
  const [state, action, pending] = useActionState(setNeighbourhoodPublishedAction, INITIAL);
  return (
    <>
      <Outcome state={state} testId={`publish-${n.id}`} />
      <form action={action} className="form-actions">
        <input type="hidden" name="areaId" value={n.id} />
        <input type="hidden" name="published" value={n.isPublished ? "false" : "true"} />
        <SubmitButton pending={pending} pendingLabel="Saving…" variant="secondary" testId={`publish-${n.slug}`}>
          {n.isPublished ? "Unpublish" : "Publish"}
        </SubmitButton>
      </form>
    </>
  );
}

export function NeighbourhoodTowns({ towns, minListings }: { towns: AdminNeighbourhoodTown[]; minListings: number }) {
  if (towns.length === 0) {
    return (
      <EmptyState title="No neighbourhoods yet." testId="neighbourhoods-empty">
        <p>Import a CSV above to add the first ones.</p>
      </EmptyState>
    );
  }
  return (
    <>
      {towns.map((t) => (
        <section key={t.cityId} aria-labelledby={`town-${t.cityId}`} data-testid={`town-${t.citySlug}`}>
          <h2 id={`town-${t.cityId}`}>
            <a href={`/${t.citySlug}`}>{t.cityName}</a>
          </h2>
          <table className="table-cards">
            <thead>
              <tr><th>Neighbourhood</th><th>Listings</th><th>Radius</th><th>Status</th><th>Action</th></tr>
            </thead>
            <tbody>
              {t.neighbourhoods.map((n) => (
                <tr key={n.id} data-testid={`neighbourhood-${n.slug}`}>
                  <td data-label="Neighbourhood">
                    <a href={`/${t.citySlug}/${n.slug}`}>{n.name}</a>
                  </td>
                  <td data-label="Listings">
                    {n.listingCount}
                    {n.listingCount < minListings && <span className="text-muted"> (noindex below {minListings})</span>}
                  </td>
                  <td data-label="Radius">{n.radiusKm === null ? "—" : `${n.radiusKm} km`}</td>
                  <td data-label="Status">
                    {n.isPublished
                      ? <span className="pill">Published</span>
                      : <span className="pill pill-danger">Unpublished</span>}
                  </td>
                  <td data-label="Action"><PublishToggle n={n} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </>
  );
}
