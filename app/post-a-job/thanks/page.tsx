import type { Metadata } from "next";
import { siteConfig } from "@/config/site.config";
import { guardFeature } from "@/lib/features/guard";
import { Notice } from "@/components/ui/Notice";
import { PageHeader } from "@/components/ui/PageHeader";

export const metadata: Metadata = {
  title: "Job post received",
  robots: { index: false, follow: false },
};

export default function PostAJobThanksPage() {
  guardFeature("jobBoard");
  return (
    <main data-testid="post-job-thanks">
      <div className="mx-auto max-w-2xl">
        <PageHeader title="Thanks — we have your job post" />
        <Notice variant="success" title="What happens next">
          <p>
            Someone reads every post before it goes on {siteConfig.name}. We will email you when it is
            live, and again {siteConfig.jobs.reminderDays} days before it closes.
          </p>
          <p className="mb-0">
            <a href="/jobs">See the jobs that are open now</a>
          </p>
        </Notice>
      </div>
    </main>
  );
}
