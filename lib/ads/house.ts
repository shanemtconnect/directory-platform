import { siteConfig } from "@/config/site.config";

/**
 * The site's own cards: what a rail shows before any sponsor has paid, and
 * what fills the slots sponsors have not. Every word comes from the config —
 * nothing here would change for a different niche (constraint 1).
 */
export interface HouseAd {
  readonly id: "claim" | "verify" | "advertise";
  readonly title: string;
  readonly blurb: string;
  readonly href: string;
}

export function houseAds(config: typeof siteConfig = siteConfig): readonly HouseAd[] {
  const e = config.entity;
  return [
    {
      id: "claim",
      title: `Claim your ${e.singular}`,
      blurb: `Is your ${e.singular} listed here? Claim it free and keep it up to date.`,
      href: "/advertise",
    },
    {
      id: "verify",
      title: "Get verified",
      blurb: `A verified ${e.singular} shows people we checked it. See what each plan includes.`,
      href: "/pricing",
    },
    {
      id: "advertise",
      title: "Advertise here",
      blurb: `Reach people choosing a ${e.singular} right now. Sponsor this space.`,
      href: "/advertise/sponsor",
    },
  ];
}
