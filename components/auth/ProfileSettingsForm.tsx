"use client";

import { useActionState } from "react";
import { saveProfile, type ProfileFormState } from "@/lib/actions/profile";

const initial: ProfileFormState = { status: "idle" };

export interface ProfileSettingsFormProps {
  name: string;
  phone: string;
  marketingOptIn: boolean;
  /** Shown, never submitted: changing it is a separate, verified flow. */
  email: string;
}

/**
 * Name, phone and one consent box.
 *
 * The email address is displayed disabled rather than left out. People look
 * for it here, and an account page that does not show which address it belongs
 * to is the reason somebody signs up twice — but changing it is a different
 * job with its own confirmation round trip, so the field says so instead of
 * pretending to be editable.
 */
export function ProfileSettingsForm({
  name,
  phone,
  marketingOptIn,
  email,
}: ProfileSettingsFormProps) {
  const [state, action, pending] = useActionState(saveProfile, initial);
  const err = state.fieldErrors ?? {};

  return (
    <form action={action} data-testid="profile-form" className="card max-w-xl">
      <p>
        <label htmlFor="pf-email">Email</label>
        <input id="pf-email" type="email" value={email} disabled readOnly />
        <small>
          Write to us if you need this changed — it is what we use to reach you about
          anything you own here.
        </small>
      </p>
      <p>
        <label htmlFor="pf-name">Your name</label>
        <input
          id="pf-name"
          name="name"
          defaultValue={name}
          required
          autoComplete="name"
          aria-describedby={err.name ? "pf-name-error" : undefined}
        />
        {err.name && (
          <span role="alert" id="pf-name-error">
            {err.name}
          </span>
        )}
      </p>
      <p>
        <label htmlFor="pf-phone">Phone (optional)</label>
        <input
          id="pf-phone"
          name="phone"
          type="tel"
          defaultValue={phone}
          autoComplete="tel"
          aria-describedby={err.phone ? "pf-phone-error" : undefined}
        />
        <small>Only used if we need to reach you about a claim. Never published.</small>
        {err.phone && (
          <span role="alert" id="pf-phone-error">
            {err.phone}
          </span>
        )}
      </p>
      <p>
        <label htmlFor="pf-marketing">
          <input
            id="pf-marketing"
            name="marketingOptIn"
            type="checkbox"
            defaultChecked={marketingOptIn}
          />{" "}
          Email me occasionally about new features and tips for getting more enquiries.
        </label>
        <small>Unticked by default, and you can untick it again at any time.</small>
      </p>
      {state.message && (
        <p role={state.status === "error" ? "alert" : "status"} data-testid="profile-message">
          {state.message}
        </p>
      )}
      <button type="submit" disabled={pending} className="btn btn-primary">
        {pending ? "Saving…" : "Save changes"}
      </button>
    </form>
  );
}
