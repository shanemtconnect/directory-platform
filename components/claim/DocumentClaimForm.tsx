"use client";

import { useState, type FormEvent } from "react";
import { confirmClaimDocument, prepareClaimDocument } from "@/lib/actions/claim";
import { Notice } from "@/components/ui/Notice";
import { SubmitButton } from "@/components/ui/SubmitButton";

/**
 * The manual rung.
 *
 * Three steps rather than one form post, because the file must never travel
 * through the app server: the action opens the claim and signs a POST policy,
 * the browser sends the bytes straight to the private bucket, and a second
 * action records where they landed. A body-size limit on a server action is not
 * something to design an eight-megabyte upload around.
 */

const ACCEPT = "application/pdf,image/jpeg,image/png";
const MAX_BYTES = 8 * 1024 * 1024;

export interface DocumentClaimFormProps {
  listingId: string;
}

export function DocumentClaimForm({ listingId }: DocumentClaimFormProps) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const file = form.get("document");
    setError(null);

    if (!(file instanceof File) || file.size === 0) {
      return setError("Please choose a document.");
    }
    // Checked again by the POST policy R2 enforces; this is only so the
    // reader is told before spending a minute uploading.
    if (file.size > MAX_BYTES) return setError("That file is larger than 8 MB.");

    setPending(true);
    try {
      const prepared = await prepareClaimDocument({
        listingId,
        claimantName: String(form.get("claimantName") ?? ""),
        roleAtBusiness: String(form.get("roleAtBusiness") ?? ""),
        evidenceNotes: String(form.get("evidenceNotes") ?? ""),
        contentType: file.type,
      });
      if (!prepared.ok) return setError(prepared.message);

      const upload = new FormData();
      for (const [k, v] of Object.entries(prepared.fields)) upload.set(k, v);
      // Last, and after the policy fields: S3-style POST ignores anything sent
      // after the file part.
      upload.set("file", file);
      const response = await fetch(prepared.url, { method: "POST", body: upload });
      if (!response.ok) return setError("The upload did not complete. Please try again.");

      const confirmed = await confirmClaimDocument({
        claimId: prepared.claimId, key: prepared.key,
      });
      if (!confirmed.ok) return setError(confirmed.message ?? "Something went wrong.");
      setDone(true);
    } catch {
      setError("The upload did not complete. Please try again.");
    } finally {
      setPending(false);
    }
  }

  if (done) {
    return (
      <Notice variant="success" testId="claim-document-sent" title="We have your document">
        <p>Someone will look at it and email you either way, usually within two working days.</p>
        <p className="mb-0">
          <strong>What happens next:</strong> the claim shows as in progress on{" "}
          <a href="/account">your account</a>. If it is approved the listing appears there; if
          not, the email says why and you can try again with different evidence.
        </p>
      </Notice>
    );
  }

  return (
    <form onSubmit={onSubmit} data-testid="claim-document-form" className="card">
      <h2 className="mt-0 text-[length:var(--text-h3)]">Send a document instead</h2>
      <p className="text-muted">
        A utility bill, headed letter or registration certificate showing the business name and
        address. PDF, JPEG or PNG, up to 8 MB. Only our review team can open it, and we delete it
        30 days after the decision.
      </p>

      <p>
        <label htmlFor="doc-name">Your name</label>
        <input id="doc-name" name="claimantName" required maxLength={120} autoComplete="name" />
      </p>

      <p>
        <label htmlFor="doc-role">Your role</label>
        <input id="doc-role" name="roleAtBusiness" maxLength={120} />
      </p>

      <p>
        <label htmlFor="doc-file">Document</label>
        <input id="doc-file" name="document" type="file" accept={ACCEPT} required />
      </p>

      <p>
        <label htmlFor="doc-notes">Anything we should know (optional)</label>
        <textarea id="doc-notes" name="evidenceNotes" rows={3} maxLength={1000} />
      </p>

      {error && (
        <Notice variant="error" testId="claim-document-error">
          {error}
        </Notice>
      )}

      <SubmitButton pending={pending} pendingLabel="Uploading…" variant="secondary" block>
        Send for review
      </SubmitButton>
    </form>
  );
}
