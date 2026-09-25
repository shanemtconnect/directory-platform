import type { LeadRejection } from "./rules";

/**
 * What a requester is told when the lead rules refuse them at submit (D11:
 * "requester told"). One wording for the capture box and the get-quotes
 * form, so a person refused by one is not told something different by the
 * other. Outside the "use server" action modules because those may only
 * export async functions.
 */
export interface LeadRefusal {
  message: string;
  fieldErrors?: Record<string, string>;
}

const CHECK_FIELDS = "Please check the fields marked below.";

export function leadRefusal(reason: LeadRejection): LeadRefusal {
  switch (reason) {
    case "phone_invalid":
      return {
        message: CHECK_FIELDS,
        fieldErrors: { phone: "Please give a phone number we can call, including the area code." },
      };
    case "disposable_email":
      return {
        message: CHECK_FIELDS,
        fieldErrors: { email: "Please use an email address you will still have next week." },
      };
    case "duplicate":
      return {
        message:
          "You have sent us a request from these details in the last 30 days. That one still stands — there is no need to send it again.",
      };
    case "blocklisted":
      // Deliberately unspecific: saying which detail is refused would only
      // tell a bad actor which one to change.
      return { message: "We can't accept a request from these contact details." };
  }
}
