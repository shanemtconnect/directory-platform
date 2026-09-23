import type { Metadata } from "next";
import { siteConfig } from "@/config/site.config";

export const metadata: Metadata = {
  title: "Thanks — we have your report",
  description: "What happens next with the correction you just sent.",
  robots: { index: false, follow: true },
};

export default function ReportThanksPage() {
  return (
    <main>
      <h1>Thanks — we have it</h1>

      <p data-testid="report-thanks">
        A person reads every report. If the correction is clear we make it; if we need to
        check something first, we do that before changing anything on the site.
      </p>

      <p>
        We only write back if we have a question, and only if you left us an address.
      </p>

      <p>
        Anything else: <a href={`mailto:${siteConfig.supportEmail}`}>{siteConfig.supportEmail}</a>.
      </p>

      <p>
        <a href="/">Back to {siteConfig.name}</a>
      </p>
    </main>
  );
}
