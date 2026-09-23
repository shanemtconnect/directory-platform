"use client";

import { useActionState } from "react";
import { siteConfig } from "@/config/site.config";
import { closeSpotAction, openSpotAction, setSpotFloorAction, type AdminSpotState } from "@/lib/actions/admin-spots";
import type { EmptySpotRow } from "@/lib/spots/availability";
import { Notice } from "@/components/ui/Notice";
import { SubmitButton } from "@/components/ui/SubmitButton";

const INITIAL: AdminSpotState = { status: "idle" };

const money = (cents: number) =>
  new Intl.NumberFormat(siteConfig.locale, { style: "currency", currency: siteConfig.currency, maximumFractionDigits: 0 }).format(cents / 100);

/**
 * The availability table (Task 45, requirement 5): area × category, how many
 * of the positions are taken, the top amount, the floor — editable — and
 * close/open. A row without a spot id is a page nobody has bid on yet; its
 * first admin edit creates the row.
 */
function SpotRowView({ row }: { row: EmptySpotRow }) {
  const [closed, close, closing] = useActionState(closeSpotAction, INITIAL);
  const [opened, open, opening] = useActionState(openSpotAction, INITIAL);
  const [floored, floor, flooring] = useActionState(setSpotFloorAction, INITIAL);
  const states = [closed, opened, floored].filter((s) => s.key === row.keyString);
  const failure = states.find((s) => s.status === "error")?.message ?? null;
  const done = states.find((s) => s.status === "done")?.message ?? null;
  const label = row.categoryName === null ? row.areaName : `${row.categoryName} in ${row.areaName}`;
  const empty = row.status === "open" && row.filled < row.positions;
  const id = `floor-${row.keyString.replace(/[^a-z0-9]/gi, "-")}`;

  return (
    <tr data-testid="admin-spot-row" data-spot={row.keyString} data-status={row.status} data-empty={empty}>
      <th scope="row" className="text-left font-normal">
        {row.path === null ? label : <a href={row.path}>{label}</a>}
        <span className="block text-xs text-muted">{row.key.areaKind}{row.spotId === null ? " · no bids yet" : ""}</span>
        {row.spotId !== null && (
          <a href={`/spots/${row.spotId}`} className="text-xs text-muted">leaderboard</a>
        )}
      </th>
      <td data-testid="admin-spot-filled">
        {row.filled} of {row.positions}
        {row.status === "closed" && <span className="pill"> closed</span>}
      </td>
      <td data-testid="admin-spot-top">{row.topCents === null ? <span className="text-muted">—</span> : money(row.topCents)}</td>
      <td>
        <form action={floor} className="flex items-center gap-2">
          <input type="hidden" name="key" value={row.keyString} />
          <label htmlFor={id} className="sr-only">Floor for {label}</label>
          <input id={id} name="floor" type="number" min={1} step={1} defaultValue={Math.round(row.floorCents / 100)} className="w-24" data-testid="admin-spot-floor" />
          <SubmitButton pending={flooring} pendingLabel="Saving…" variant="secondary" testId="admin-spot-floor-save">Save</SubmitButton>
        </form>
      </td>
      <td>
        {row.status === "open" ? (
          <form action={close}>
            <input type="hidden" name="key" value={row.keyString} />
            <SubmitButton pending={closing} pendingLabel="Closing…" variant="secondary" testId="admin-spot-close">
              Close{row.filled > 0 ? ` (cancels ${row.filled})` : ""}
            </SubmitButton>
          </form>
        ) : (
          <form action={open}>
            <input type="hidden" name="key" value={row.keyString} />
            <SubmitButton pending={opening} pendingLabel="Opening…" variant="secondary" testId="admin-spot-open">Open</SubmitButton>
          </form>
        )}
        {failure !== null && <Notice variant="error" testId="admin-spot-message">{failure}</Notice>}
        {done !== null && failure === null && <Notice variant="success" testId="admin-spot-message">{done}</Notice>}
      </td>
    </tr>
  );
}

export function SpotTable({ rows }: { rows: EmptySpotRow[] }) {
  return (
    <table className="w-full text-sm" data-testid="admin-spot-table">
      <thead>
        <tr>
          <th scope="col" className="text-left">Spot</th>
          <th scope="col" className="text-left">Taken</th>
          <th scope="col" className="text-left">Top bid</th>
          <th scope="col" className="text-left">Floor / month</th>
          <th scope="col" className="text-left">Bidding</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => <SpotRowView key={row.keyString} row={row} />)}
      </tbody>
    </table>
  );
}
