"use client";

import { useActionState } from "react";
import { placeBidAction, type BidState } from "@/lib/actions/spots";
import type { SpotKey } from "@/lib/db/queries/spots";
import { Notice } from "@/components/ui/Notice";
import { SubmitButton } from "@/components/ui/SubmitButton";

const initial: BidState = { status: "idle" };

export interface BidFormProps {
  listingId: string;
  spot: SpotKey;
  keyString: string;
  /** Prefilled: the owner's current bid, or the minimum to enter. In major units. */
  defaultAmount: number;
  currencySymbol: string;
  hasBid: boolean;
  disabled?: boolean;
}

/**
 * One amount box and one button per spot. The spot is carried in hidden
 * fields; the action re-checks ownership, eligibility and the spot's rules
 * regardless — this form is a suggestion.
 */
export function BidForm({ listingId, spot, keyString, defaultAmount, currencySymbol, hasBid, disabled = false }: BidFormProps) {
  const [state, action, pending] = useActionState(placeBidAction, initial);
  const id = `bid-${keyString.replace(/[^a-z0-9]/gi, "-")}`;

  return (
    <form action={action} data-testid="bid-form" data-spot={keyString} className="flex flex-col gap-2">
      <input type="hidden" name="listingId" value={listingId} />
      <input type="hidden" name="areaKind" value={spot.areaKind} />
      <input type="hidden" name="areaId" value={spot.areaId} />
      <input type="hidden" name="categoryId" value={spot.categoryId ?? ""} />
      <div className="flex items-center gap-2">
        <label htmlFor={id} className="sr-only">Monthly bid</label>
        <span aria-hidden="true">{currencySymbol}</span>
        <input
          id={id}
          name="amount"
          type="number"
          inputMode="numeric"
          min={1}
          step={1}
          defaultValue={defaultAmount}
          disabled={disabled}
          className="w-24"
          data-testid="bid-amount"
        />
        <SubmitButton pending={pending} pendingLabel="Sending…" testId="bid-submit" variant={hasBid ? "secondary" : "primary"}>
          {hasBid ? "Change bid" : "Bid"}
        </SubmitButton>
      </div>
      {state.message && state.keyString === keyString && (
        <Notice variant={state.status === "error" ? "error" : "success"} testId="bid-message">
          {state.message}
        </Notice>
      )}
    </form>
  );
}
