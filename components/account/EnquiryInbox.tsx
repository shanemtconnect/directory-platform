"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { markEnquiry } from "@/lib/actions/owner";

export interface InboxEnquiry {
  id: string;
  /** ISO, so the server does not have to agree with the browser about format. */
  createdAt: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  message: string | null;
  read: boolean;
  replied: boolean;
}

/**
 * The owner's inbox.
 *
 * Read and Replied are recorded rather than inferred. `replied_at` and the
 * response time it produces are what the public "usually replies within N
 * hours" figure is built from, and a figure nobody confirmed is a figure we
 * should not be publishing.
 */
export function EnquiryInbox({ enquiries, locale }: { enquiries: InboxEnquiry[]; locale: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  // Optimistic only for the button state; the truth arrives with the refresh.
  const [touched, setTouched] = useState<Record<string, "read" | "replied">>({});

  function mark(id: string, action: "read" | "replied"): void {
    setTouched((t) => ({ ...t, [id]: action }));
    startTransition(async () => {
      await markEnquiry(id, action);
      router.refresh();
    });
  }

  if (enquiries.length === 0) {
    return <p data-testid="no-enquiries">No enquiries yet.</p>;
  }

  return (
    <ul data-testid="enquiry-inbox" className="link-grid">
      {enquiries.map((e) => {
        const state = touched[e.id];
        const read = e.read || state !== undefined;
        const replied = e.replied || state === "replied";
        return (
          <li key={e.id} className="card" data-testid="enquiry-row" data-read={read}>
            <p className="text-sm text-muted">
              <time dateTime={e.createdAt}>{new Date(e.createdAt).toLocaleString(locale)}</time>
              {!read && <strong data-testid="enquiry-unread"> · Unread</strong>}
              {replied && <span> · Replied</span>}
            </p>
            <p><strong>{e.name ?? "No name given"}</strong></p>
            {e.email && <p><a href={`mailto:${e.email}`}>{e.email}</a></p>}
            {e.phone && <p><a href={`tel:${e.phone.replace(/\s/g, "")}`}>{e.phone}</a></p>}
            {e.message && <p className="whitespace-pre-line">{e.message}</p>}
            <p className="flex gap-3">
              {!read && (
                <button type="button" className="btn" disabled={pending}
                  onClick={() => mark(e.id, "read")}>
                  Mark read
                </button>
              )}
              {!replied && (
                <button type="button" className="btn" disabled={pending}
                  onClick={() => mark(e.id, "replied")}>
                  Mark replied
                </button>
              )}
            </p>
          </li>
        );
      })}
    </ul>
  );
}
