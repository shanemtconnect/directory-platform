"use client";

import { useActionState } from "react";
import { saveOwnerListing, type OwnerFormState } from "@/lib/actions/owner";
import { DAY_KEYS } from "@/lib/account/form";

const initial: OwnerFormState = { status: "idle" };

const DAY_LABELS: Record<string, string> = {
  mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday",
  fri: "Friday", sat: "Saturday", sun: "Sunday",
};

export interface ListingEditorProps {
  listingId: string;
  description: string;
  phone: string;
  website: string;
  /** One URL per line. */
  socials: string;
  openingHours: Record<string, string>;
  maxDescriptionChars: number;
  /**
   * Whether this listing's tier renders the field publicly. The input is shown
   * either way — an owner filling in a website they will get on upgrading is
   * exactly the right moment to say so — but the note keeps the promise honest.
   */
  showsWebsite: boolean;
  showsSocial: boolean;
}

export function ListingEditor(props: ListingEditorProps) {
  const [state, action, pending] = useActionState(saveOwnerListing, initial);

  return (
    <form action={action} data-testid="listing-editor" className="card">
      <input type="hidden" name="listingId" value={props.listingId} />

      <p>
        <label htmlFor="ed-description">Description</label>
        <textarea
          id="ed-description" name="description" rows={8}
          maxLength={props.maxDescriptionChars} defaultValue={props.description}
          aria-invalid={Boolean(state.fieldErrors?.description)}
        />
        {state.fieldErrors?.description && <span role="alert">{state.fieldErrors.description}</span>}
      </p>

      <p>
        <label htmlFor="ed-phone">Phone</label>
        <input
          id="ed-phone" name="phone" type="tel" maxLength={40}
          defaultValue={props.phone} aria-invalid={Boolean(state.fieldErrors?.phone)}
        />
        {state.fieldErrors?.phone && <span role="alert">{state.fieldErrors.phone}</span>}
      </p>

      <p>
        <label htmlFor="ed-website">Website</label>
        <input
          id="ed-website" name="website" type="url" maxLength={300}
          defaultValue={props.website} aria-invalid={Boolean(state.fieldErrors?.website)}
        />
        {!props.showsWebsite && (
          <span className="text-sm text-muted">
            Shown on the public page from <a href="/pricing">Essential</a> upwards.
          </span>
        )}
        {state.fieldErrors?.website && <span role="alert">{state.fieldErrors.website}</span>}
      </p>

      <p>
        <label htmlFor="ed-socials">Social links, one per line</label>
        <textarea
          id="ed-socials" name="socials" rows={4} defaultValue={props.socials}
          aria-invalid={Boolean(state.fieldErrors?.socials)}
        />
        {!props.showsSocial && (
          <span className="text-sm text-muted">
            Shown on the public page from <a href="/pricing">Essential</a> upwards.
          </span>
        )}
        {state.fieldErrors?.socials && <span role="alert">{state.fieldErrors.socials}</span>}
      </p>

      <fieldset>
        <legend>Opening hours</legend>
        {state.fieldErrors?.openingHours && (
          <p role="alert">{state.fieldErrors.openingHours}</p>
        )}
        {DAY_KEYS.map((day) => (
          <p key={day}>
            <label htmlFor={`ed-hours-${day}`}>{DAY_LABELS[day]}</label>
            <input
              id={`ed-hours-${day}`} name={`hours-${day}`} maxLength={60}
              placeholder="09:00–17:00, or Closed"
              defaultValue={props.openingHours[day] ?? ""}
            />
          </p>
        ))}
      </fieldset>

      {state.status === "saved" && (
        <p role="status" data-testid="listing-saved">Saved. The public page has been updated.</p>
      )}
      {state.message && <p role="alert" data-testid="listing-error">{state.message}</p>}

      <button type="submit" disabled={pending} className="btn btn-primary">
        {pending ? "Saving…" : "Save changes"}
      </button>
    </form>
  );
}
