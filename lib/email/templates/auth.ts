import { siteConfig } from "@/config/site.config";
import { layout, type EmailContent } from "./layout";

/**
 * The two emails the auth flow sends.
 *
 * Both are built exactly like every other notification in this directory —
 * `layout()` escapes each value — but they carry one thing the others do not:
 * a single-use token in a URL. That shapes the copy.
 *
 *  - The lifetime is stated. A link that has quietly expired is indistinguishable
 *    from a broken site, and the person who hits it has no way to tell which.
 *  - The reset email says what to do if you did not ask for it. It is the one
 *    transactional email a stranger can cause to be sent to your address, so
 *    "ignore this" is not filler, it is the answer to the obvious question.
 *  - Neither threatens the account. `requireEmailVerification` is false, so an
 *    unverified owner can still sign in and still claim; copy implying otherwise
 *    would be false, and false urgency in an email containing a link is exactly
 *    the pattern we are asking people to be suspicious of.
 *
 * Nothing here is niche-specific: an address is an address whatever the site lists.
 */

export interface AuthEmailData {
  /** The account's own name. Rendered escaped — it is user input. */
  name: string;
  /** The full link, token included. */
  url: string;
  /** Stated in the body so an expired link is explicable. */
  expiresInMinutes: number;
}

function lifetime(minutes: number): string {
  return minutes >= 120 ? `${Math.round(minutes / 60)} hours` : `${minutes} minutes`;
}

export function passwordReset(data: AuthEmailData): EmailContent {
  const subject = `Reset your ${siteConfig.name} password`;
  return {
    subject,
    ...layout({
      subject,
      heading: `Hello ${data.name}`,
      blocks: [
        { value: `Use the link below to set a new password. It works once, and for ${lifetime(data.expiresInMinutes)}.` },
        { value: "Set a new password", href: data.url },
        {
          value:
            "If you did not ask for this, you can ignore this email — nothing has changed, " +
            "and your current password still works.",
        },
      ],
    }),
  };
}

export function verifyEmailAddress(data: AuthEmailData): EmailContent {
  const subject = `Confirm your email address — ${siteConfig.name}`;
  return {
    subject,
    ...layout({
      subject,
      heading: `Hello ${data.name}`,
      blocks: [
        {
          value:
            `Confirming your address lets us reach you about anything you list or claim. ` +
            `The link works once, and for ${lifetime(data.expiresInMinutes)}.`,
        },
        { value: "Confirm my email address", href: data.url },
        {
          value:
            "You can carry on using your account either way — this only tells us the " +
            "address reaches you.",
        },
      ],
    }),
  };
}
