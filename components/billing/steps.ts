/**
 * The checkout flow, as the buyer sees it. Shared by the picker, the plan
 * page and the return page so the three agree on the step names.
 */
export const CHECKOUT_STEPS = ["Choose the listing", "Confirm the plan", "Pay at PayPal", "Done"] as const;
