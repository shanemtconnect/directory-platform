/**
 * The verification token as it arrives in a path segment. A malformed
 * percent-escape (`%E0%A4%A`) makes `decodeURIComponent` throw; that is a
 * link we do not recognise, not a server error, so it decodes to "" — which
 * every lookup treats as unknown.
 */
export function decodeTokenParam(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return "";
  }
}
