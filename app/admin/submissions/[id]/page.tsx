import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { db } from "@/lib/db/client";
import { siteConfig } from "@/config/site.config";
import { currentViewer } from "@/lib/auth/viewer";
import { submissionDetail } from "@/lib/db/queries/admin/submissions";
import { approveSubmissionAction } from "@/lib/actions/admin";
import { AdminNav } from "@/components/admin/AdminNav";
import { RejectSubmissionForm } from "@/components/admin/RejectSubmissionForm";

export const metadata: Metadata = {
  title: "Submission",
  robots: { index: false, follow: false },
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function when(value: Date): string {
  return new Intl.DateTimeFormat(siteConfig.locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: siteConfig.timezone,
  }).format(value);
}

/** A field nobody filled in reads as "not given", never as an empty row. */
function Field({ label, value }: { label: string; value: string | null }) {
  return (
    <>
      <dt className="text-sm font-semibold uppercase tracking-wide text-muted">{label}</dt>
      <dd className="mb-4">{value ?? <span className="text-muted">not given</span>}</dd>
    </>
  );
}

export default async function SubmissionDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();

  const viewer = await currentViewer();
  const detail = await submissionDetail(db, viewer, id);
  if (!detail) notFound();

  const decided = detail.status !== "pending";

  return (
    <main>
      <AdminNav current="/admin/submissions" />
      <p className="text-sm">
        <a href="/admin/submissions">← Back to the queue</a>
      </p>
      <h1>{detail.name}</h1>
      <p className="text-muted">
        Submitted {when(detail.createdAt)} · currently <strong>{detail.status}</strong>
      </p>

      <section>
        <h2>What was submitted</h2>
        <dl className="grid gap-x-8 sm:grid-cols-2">
          <Field label={`${siteConfig.entity.Singular} name`} value={detail.name} />
          <Field label="Category" value={detail.categoryName} />
          <Field label="Town as typed" value={detail.submittedCity} />
          <Field label={`${siteConfig.regionLabel} as typed`} value={detail.submittedRegion} />
          <Field label="Filed under" value={detail.cityName} />
          <Field label="Address" value={detail.addressLine1} />
          <Field label="Postcode" value={detail.postcode} />
          <Field label="Phone" value={detail.phone} />
          <Field label="Website" value={detail.website} />
          <Field label="Submitted by" value={detail.submitterName} />
          <Field label="Reply to" value={detail.submitterEmail} />
          <Field label="Plan asked for" value={detail.requestedTier} />
        </dl>
        <h3>Description</h3>
        <p className="whitespace-pre-line">
          {detail.description ?? <span className="text-muted">not given</span>}
        </p>
      </section>

      {decided ? (
        <section>
          <h2>Already decided</h2>
          <p>
            This is <strong>{detail.status}</strong>, so there is nothing left to decide here.
          </p>
          {detail.rejectedReason !== null && (
            <p>
              <span className="text-sm font-semibold uppercase tracking-wide text-muted">
                Reason given
              </span>
              <br />
              {detail.rejectedReason}
            </p>
          )}
          {detail.status === "published" && (
            <p>
              <a href={`/${detail.citySlug}/${detail.slug}`}>View the live page</a>
            </p>
          )}
        </section>
      ) : (
        <section>
          <h2>Decide</h2>
          <div className="card mb-6">
            <h3 className="mt-0">Approve</h3>
            <p>
              Publishes it, stamps the publication date and recomputes {detail.cityName}
              &rsquo;s indexing. The submitter is emailed the link.
            </p>
            <form action={approveSubmissionAction} data-testid="approve-form">
              <input type="hidden" name="listingId" value={detail.id} />
              <button type="submit" data-testid="approve-submit">
                Approve and publish
              </button>
            </form>
          </div>

          <div className="card">
            <h3 className="mt-0">Reject</h3>
            <RejectSubmissionForm listingId={detail.id} />
          </div>
        </section>
      )}
    </main>
  );
}
