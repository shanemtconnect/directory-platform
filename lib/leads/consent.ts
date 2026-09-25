import { siteConfig } from "@/config/site.config";

/**
 * What we tell a requester about who sees their details once the lead
 * marketplace is on — the ONE place the sentence is written.
 *
 * With `leadMarketplace` off every form and email keeps its original "we
 * don't sell your details" wording, untouched. With it on that line would be
 * false (a request no paying local received is sold as a lead), so the
 * enquiry form, the get-quotes form, the capture box and the requester's
 * acknowledgement email show this instead. Wording flagged to Shane; change
 * it here and nowhere else.
 *
 * No hooks, no server imports: client components read it too.
 */
export function leadSharingNotice(config: typeof siteConfig = siteConfig): string {
  return (
    `We pass your request to matching ${config.entity.plural}, who may pay us to receive it. ` +
    `We never share it with anyone else.`
  );
}
