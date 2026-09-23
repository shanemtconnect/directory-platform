/**
 * The letter a sponsor card shows when there is no logo. Its own module so
 * a client component (the admin queue's preview) can import it without
 * dragging sharp and the R2 client into the browser bundle.
 */
export function sponsorInitial(name: string): string {
  const first = name.trim().match(/\p{L}|\p{N}/u);
  return first ? first[0].toUpperCase() : "•";
}
