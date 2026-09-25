/**
 * How long a requester has to click the quote verification link (Task 56).
 * Stated in the email and on the form, enforced by `verifyQuoteToken`, swept
 * by the worker's `quotes.expire` job — one number for all of them. Its own
 * module so the client-side form can import it without pulling the query
 * module (and the database) into the browser bundle.
 */
export const QUOTE_VERIFY_TTL_HOURS = 48;
