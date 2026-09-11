import type { Metadata } from "next";
import { siteConfig } from "@/config/site.config";
import { REMOVAL_SLA_WORKING_DAYS } from "@/lib/trust/working-days";

export const metadata: Metadata = {
  title: "Thanks — we have your removal request",
  description: "What happens next with the removal request you just sent.",
  robots: { index: false, follow: true },
};

export default function RemoveThanksPage() {
  return (
    <main>
      <h1>Thanks — we have your request</h1>

      <p data-testid="removal-thanks">
        We action removal requests within <strong>{REMOVAL_SLA_WORKING_DAYS} working days</strong>.
        A person reads every one of them, and we email you at the address you gave us when it is
        done.
      </p>

      <h2>What happens next</h2>
      <ol>
        <li>Someone checks the request against the listing.</li>
        <li>
          If we take the listing down, we also record enough to stop a later update from putting
          it back. You do not need to ask twice.
        </li>
        <li>
          If we need anything from you before we can act, we email you rather than quietly
          leaving it.
        </li>
      </ol>

      <p>
        Heard nothing, or need it sooner? Email{" "}
        <a href={`mailto:${siteConfig.supportEmail}`}>{siteConfig.supportEmail}</a> and we will
        pick it up.
      </p>

      <p>
        <a href="/data-sources">Where our listing information comes from</a>
      </p>
    </main>
  );
}
