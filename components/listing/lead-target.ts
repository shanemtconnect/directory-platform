/**
 * Whether an enquiry to this listing would become a lead rather than reach
 * an owner: the lead marketplace is on and the listing is unclaimed with no
 * email on file — the same rule `enquiryLeadTarget` applies in the database
 * (lib/db/queries/leads.ts), here for the form's wording only.
 */
export function isLeadTarget(
  leadMarketplace: boolean,
  listing: { claimStatus: string; email: string | null },
): boolean {
  return leadMarketplace && listing.claimStatus === "unclaimed" && (listing.email ?? "").trim() === "";
}
