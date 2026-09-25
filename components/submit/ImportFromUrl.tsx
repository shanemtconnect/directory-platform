"use client";

import { useActionState } from "react";
import { importFromUrl, type ImportFromUrlState } from "@/lib/actions/import-listing";
import type { SubmissionFormValues } from "@/lib/actions/validation";
import { SubmitListingForm, type SubmitListingFormProps } from "./SubmitListingForm";

/**
 * The last result, plus what the form below is prefilled with and a counter
 * that changes only when that prefill does. Kept apart from the result so a
 * failed second attempt does not wipe what the first one filled in.
 */
interface Local {
  result: ImportFromUrlState;
  values: Partial<SubmissionFormValues>;
  imports: number;
}

const initial: Local = { result: { status: "idle" }, values: {}, imports: 0 };

async function runImport(prev: Local, form: FormData): Promise<Local> {
  const result = await importFromUrl(prev.result, form);
  if (result.status !== "imported") return { ...prev, result };
  // `socials` has no field on this form; everything else maps by name.
  const { socials: _socials, ...values } = result.values;
  return { result, values, imports: prev.imports + 1 };
}

/**
 * "Have a website? Paste the address and we'll fill in what we can."
 *
 * A small form of its own ABOVE the submission form — never nested in it —
 * whose result becomes the submission form's `initialValues`. Prefilled
 * fields stay editable, and nothing is submitted until the person presses
 * Submit on the form below.
 *
 * It renders the submission form itself because the page is a server
 * component and the import result is client state: this is the nearest
 * common parent. Each successful import remounts the form (`key`) so its
 * uncontrolled inputs pick up the new defaults.
 */
export function ImportFromUrl(props: Omit<SubmitListingFormProps, "initialValues">) {
  const [{ result: state, values, imports }, action, pending] = useActionState(runImport, initial);
  const filled = Object.keys(values).length;

  return (
    <>
      <form action={action} data-testid="import-from-url" className="card bg-raised max-w-2xl">
        {/* Honeypot. Hidden from people and from screen readers, visible to bots. */}
        <div aria-hidden="true" style={{ position: "absolute", left: "-9999px" }}>
          <label htmlFor="import_company_url">Leave this field empty</label>
          <input id="import_company_url" name="import_company_url" type="text" tabIndex={-1}
            autoComplete="off" />
        </div>

        <p>
          <label htmlFor="import-url">
            Have a website? Paste the address and we&rsquo;ll fill in what we can
          </label>
          <input id="import-url" name="url" type="text" inputMode="url" required maxLength={2048}
            placeholder="example.co.uk" autoComplete="url" aria-describedby="import-url-help" />
          <small id="import-url-help">
            Optional. We read your site&rsquo;s public details once and fill in the form below
            for you to check. Nothing is sent until you press Submit.
          </small>
        </p>

        <button type="submit" disabled={pending} className="btn">
          {pending ? "Reading your site…" : "Fill in the form"}
        </button>

        {state.status === "error" && (
          <p role="alert" data-testid="import-error">{state.message}</p>
        )}
        {state.status === "imported" && filled > 0 && (
          <p role="status" data-testid="import-done">
            We&rsquo;ve filled in what we found. Please check every field before you submit.
          </p>
        )}
      </form>

      <SubmitListingForm key={imports} {...props} initialValues={values} />
    </>
  );
}
