"use client";

import { recordApplyClick } from "@/lib/actions/jobs";

/**
 * The Apply button: a plain link the visitor follows — a mailto: or the
 * employer's own page — with the press counted on the way out. Nothing about
 * the applicant is kept; the count is the only thing the poster ever sees.
 * If the action fails the link still works: the count is a courtesy.
 */
export function ApplyLink({ jobId, href, external }: { jobId: string; href: string; external: boolean }) {
  return (
    <a
      href={href}
      className="btn btn-primary"
      data-testid="job-apply"
      onClick={() => {
        void recordApplyClick(jobId).catch(() => {});
      }}
      {...(external ? { target: "_blank", rel: "nofollow noopener" } : {})}
    >
      Apply for this job
    </a>
  );
}
