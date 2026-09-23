/**
 * The shortest rejection reason worth sending to a removal requester.
 *
 * A person told "no" is owed the actual reason, and "no" or "nope" is not a
 * reason. Lives here rather than in the query module so the admin form can
 * set the same minimum on its textarea without pulling the data layer into
 * the browser bundle — the same reason `lib/trust/labels.ts` exists.
 */
export const REJECTION_REASON_MIN_LENGTH = 10;
