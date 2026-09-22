"use client";

import { useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import {
  confirmPhotoUpload,
  deletePhoto,
  preparePhotoUpload,
  reorderPhotos,
  savePhotoAlt,
} from "@/lib/actions/photos";
import type { PhotoStatus } from "@/lib/db/queries/photos";
import { Notice } from "@/components/ui/Notice";
import { SubmitButton } from "@/components/ui/SubmitButton";

/**
 * The owner's photo manager.
 *
 * Upload is three steps rather than one form post, for the same reason the
 * claim document is: the file must never travel through the app server. The
 * action signs a POST policy, the browser sends the bytes straight to the
 * media bucket, and a second action records where they landed. The row then
 * shows as "Processing" until the worker has made the sizes the public page
 * uses — typically within a minute.
 *
 * Reorder is two buttons per photo rather than drag and drop: it works with a
 * keyboard, it works on a phone, and the whole new order goes to the server
 * in one call so two tabs cannot leave the numbering in disagreement.
 */

const ACCEPT = "image/jpeg,image/png,image/webp";
const MAX_BYTES = 8 * 1024 * 1024;
const ALT_MAX = 250;

export interface ManagedPhoto {
  id: string;
  /** Absolute thumbnail URL, once the worker has made one. */
  thumbUrl: string | null;
  alt: string;
  status: PhotoStatus;
}

export interface PhotoManagerProps {
  listingId: string;
  photos: ManagedPhoto[];
  used: number;
  /** null: unlimited. */
  max: number | null;
  tierLabel: string;
  /** False when R2 is not configured: the form is replaced by a notice. */
  uploadsAvailable: boolean;
}

const STATUS_LABEL: Record<PhotoStatus, string> = {
  pending: "Processing",
  live: "Live",
  failed: "Could not be processed",
};

export function PhotoManager(props: PhotoManagerProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const full = props.max !== null && props.used >= props.max;

  function run(label: string, work: () => Promise<{ ok: boolean; message?: string }>): void {
    setError(null);
    setSaved(null);
    startTransition(async () => {
      const result = await work();
      if (!result.ok) {
        setError(result.message ?? "Something went wrong. Please try again.");
        return;
      }
      setSaved(label);
      router.refresh();
    });
  }

  async function onUpload(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const formEl = event.currentTarget;
    const file = new FormData(formEl).get("photo");
    setError(null);
    setSaved(null);

    if (!(file instanceof File) || file.size === 0) return setError("Please choose a photo.");
    // Checked again by the POST policy R2 enforces; this is only so the
    // reader is told before spending a minute uploading.
    if (file.size > MAX_BYTES) return setError("That photo is larger than 8 MB.");

    setUploading(true);
    try {
      const prepared = await preparePhotoUpload({
        listingId: props.listingId,
        contentType: file.type,
      });
      if (!prepared.ok) return setError(prepared.message);

      const upload = new FormData();
      for (const [k, v] of Object.entries(prepared.fields)) upload.set(k, v);
      // Last, and after the policy fields: S3-style POST ignores anything
      // sent after the file part.
      upload.set("file", file);
      const response = await fetch(prepared.url, { method: "POST", body: upload });
      if (!response.ok) return setError("The upload did not complete. Please try again.");

      const confirmed = await confirmPhotoUpload({ listingId: props.listingId, key: prepared.key });
      if (!confirmed.ok) return setError(confirmed.message);

      formEl.reset();
      setSaved("Photo added. It will appear on the page once it has been processed.");
      router.refresh();
    } catch {
      setError("The upload did not complete. Please try again.");
    } finally {
      setUploading(false);
    }
  }

  function move(index: number, direction: -1 | 1): void {
    const ids = props.photos.map((p) => p.id);
    const target = index + direction;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target]!, ids[index]!];
    run("Order saved.", () => reorderPhotos({ listingId: props.listingId, orderedIds: ids }));
  }

  function onAlt(photoId: string, event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const alt = String(new FormData(event.currentTarget).get("alt") ?? "");
    run("Description saved.", () => savePhotoAlt({ listingId: props.listingId, photoId, alt }));
  }

  function remove(photoId: string): void {
    if (!window.confirm("Delete this photo? This cannot be undone.")) return;
    run("Photo deleted.", () => deletePhoto({ listingId: props.listingId, photoId }));
  }

  const busy = pending || uploading;

  return (
    <div data-testid="photo-manager">
      <p className="text-sm text-muted" data-testid="photo-quota">
        {props.max === null
          ? `${props.used} ${props.used === 1 ? "photo" : "photos"} · no limit on ${props.tierLabel}`
          : `${props.used} of ${props.max} photos used on ${props.tierLabel}`}
        {full && (
          <>
            {" · "}
            <a href="/pricing">Upgrade for more</a>
          </>
        )}
      </p>

      {error && (
        <Notice variant="error" testId="photo-error">
          {error}
        </Notice>
      )}
      {saved && (
        <Notice variant="success" testId="photo-saved">
          {saved}
        </Notice>
      )}

      {!props.uploadsAvailable ? (
        <Notice variant="status" testId="photos-unavailable" title="Uploads are not available yet">
          Photo storage has not been set up on this site. Your existing photos, if any, are
          listed below.
        </Notice>
      ) : full ? (
        <Notice variant="status" testId="photos-full">
          You have used every photo slot on this plan. Delete one to add another, or{" "}
          <a href="/pricing">upgrade for more</a>.
        </Notice>
      ) : (
        <form onSubmit={onUpload} className="card" data-testid="photo-upload-form">
          <h2 className="mt-0 text-[length:var(--text-h3)]">Add a photo</h2>
          <p className="text-muted">
            JPEG, PNG or WebP, up to 8 MB. Photos are resized for the page and any location data
            in the file is removed. The first photo is the one shown at the top of the page.
          </p>
          <p>
            <label htmlFor="photo-file">Photo</label>
            <input id="photo-file" name="photo" type="file" accept={ACCEPT} required />
          </p>
          <SubmitButton pending={uploading} pendingLabel="Uploading…" testId="photo-upload-submit">
            Upload
          </SubmitButton>
        </form>
      )}

      {props.photos.length === 0 ? (
        <p data-testid="no-photos">No photos yet.</p>
      ) : (
        <ol className="card-grid" data-testid="photo-list">
          {props.photos.map((photo, index) => (
            <li
              key={photo.id}
              className="card"
              data-testid="photo-row"
              data-status={photo.status}
              data-photo-id={photo.id}
            >
              {photo.thumbUrl ? (
                <img
                  src={photo.thumbUrl}
                  alt={photo.alt || `Photo ${index + 1}`}
                  width={200}
                  height={150}
                  loading="lazy"
                  className="block h-auto w-full rounded"
                />
              ) : (
                <div
                  className="flex aspect-[4/3] items-center justify-center rounded bg-raised text-sm text-muted"
                  aria-hidden="true"
                >
                  {photo.status === "failed" ? "No preview" : "Processing…"}
                </div>
              )}
              <p className="mb-1 mt-2 flex flex-wrap gap-1 text-sm">
                {index === 0 && <span className="pill pill-primary">Main photo</span>}
                <span className={photo.status === "live" ? "pill pill-on" : "pill"}>
                  {STATUS_LABEL[photo.status]}
                </span>
              </p>
              {photo.status === "failed" && (
                <p className="text-sm text-muted">
                  This file could not be read as an image. Delete it and try another.
                </p>
              )}
              <form onSubmit={(e) => onAlt(photo.id, e)} className="mb-2">
                <label htmlFor={`alt-${photo.id}`} className="text-sm">
                  Describe the photo (for screen readers and search)
                </label>
                <input
                  id={`alt-${photo.id}`}
                  name="alt"
                  defaultValue={photo.alt}
                  maxLength={ALT_MAX}
                  className="mb-1"
                />
                <SubmitButton pending={pending} pendingLabel="Saving…" variant="secondary">
                  Save description
                </SubmitButton>
              </form>
              <p className="mb-0 flex flex-wrap gap-2">
                <button
                  type="button"
                  className="btn"
                  disabled={busy || index === 0}
                  onClick={() => move(index, -1)}
                  aria-label={`Move photo ${index + 1} up`}
                >
                  Move up
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={busy || index === props.photos.length - 1}
                  onClick={() => move(index, 1)}
                  aria-label={`Move photo ${index + 1} down`}
                >
                  Move down
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={busy}
                  onClick={() => remove(photo.id)}
                  data-testid="photo-delete"
                >
                  Delete
                </button>
              </p>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
