import { siteConfig } from "@/config/site.config";
import { layout, type EmailContent } from "./layout";

/**
 * The one awards email: "you won" (Task 50).
 *
 * No `replyTo`: the award is a statement of fact from the site, not a
 * conversation, and the support address in the footer is where a question
 * about it belongs.
 */

export interface AwardEmailData {
  year: number;
  listingName: string;
  /** Absolute URL of the winner's own listing page, where the pill now shows. */
  listingUrl: string;
  /** Absolute URL of the year's winners in the listing's town. */
  awardsUrl: string;
  cityName: string;
  categoryName: string;
  /** Absolute URL of the badge kit, where the award badge style lives. */
  badgeUrl: string;
}

export function awardWon(data: AwardEmailData): EmailContent {
  const subject = `${data.listingName} is a ${siteConfig.name} ${data.year} winner`;
  return {
    subject,
    ...layout({
      subject,
      heading: `Congratulations — ${data.listingName} won for ${data.year}`,
      blocks: [
        {
          value:
            `${data.listingName} has the highest rating of any ${data.categoryName.toLowerCase()} ` +
            `${siteConfig.entity.singular} in ${data.cityName} on ${siteConfig.name}, ` +
            `based on published reviews from the people who used it.`,
        },
        { label: siteConfig.entity.Singular, value: data.listingName, href: data.listingUrl },
        { label: "Winners", value: `${data.year} winners in ${data.cityName}`, href: data.awardsUrl },
        {
          value:
            "The award is computed from published reviews only. It is never sold, never voted on, " +
            "and it stays on your listing page for the year.",
        },
        { label: "Badge", value: "Add the winner badge to your own website", href: data.badgeUrl },
      ],
    }),
  };
}
