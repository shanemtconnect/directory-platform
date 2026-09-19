/**
 * The claim flow, as the person sees it. Shared by the ladder page and the
 * confirmation page so the two agree on what step three is called.
 */
export const CLAIM_STEPS = [
  "Sign in",
  "Prove it is yours",
  "Confirm by email",
  "Manage your listing",
] as const;
