/**
 * A bounded, in-process holding area for counter increments that could not
 * reach Redis.
 *
 * `lib/redis/client.ts` hands out null while a connect is in flight or while
 * Redis is in its down-cooldown. For a counter that used to mean the count
 * was dropped: a page view during a thirty-second blip was simply never
 * recorded. Here it is held instead, keyed the way the caller will write it,
 * and handed back for writing the next time a client is available — delayed,
 * not lost.
 *
 * Bounded, because an outage that lasts and a keyspace that grows (one key
 * per listing per day per metric) would otherwise turn the buffer into a
 * memory leak with a purpose. Past the cap the OLDEST key is dropped for each
 * new one admitted: what has waited longest is the least likely to still be
 * worth the wait, and a Map's insertion order makes "oldest" free to find.
 * Losing a count at that point is the behaviour this replaces, so it is never
 * worse than before — but it is logged, once per outage, so that an operator
 * can see the cap was hit.
 *
 * Where the at-most-once / at-least-once line sits. A count is HELD only when
 * nothing was sent: the shared client was null. A write that reaches a ready
 * client and then rejects is NOT held by its caller — the command may already
 * have been applied (node-redis rejects every in-flight command when the
 * socket drops, whether or not the server had run it), and the repo's rule is
 * that a lost count beats a doubled one (`worker/jobs/flush-stats.ts`). The
 * one at-least-once window is the REPLAY in `flush`: an INCRBY that rejects
 * after the server applied it is put back and written again. That is bounded
 * to `MAX_REPLAY_ATTEMPTS` tries per entry, so the worst case is one extra
 * count per key per outage, never a flapping socket doubling for ever. After
 * the last try the entry is dropped, which is the old behaviour.
 */

export const COUNTER_BUFFER_MAX_KEYS = 10_000;

/** Times an entry is handed to `apply` before it is given up on. */
export const MAX_REPLAY_ATTEMPTS = 2;

export interface PendingIncrement {
  key: string;
  count: number;
  /** A TTL the caller asked for on this key, to apply if the flush creates it. */
  expireSeconds: number | null;
  /** Replays that have already rejected for this entry. */
  attempts: number;
}

interface Entry {
  count: number;
  expireSeconds: number | null;
  attempts: number;
}

export class CounterBuffer {
  readonly #entries = new Map<string, Entry>();
  #dropped = 0;
  #abandoned = 0;
  #overflowLogged = false;

  constructor(
    private readonly label: string,
    private readonly maxKeys: number = COUNTER_BUFFER_MAX_KEYS,
    private readonly warn: (message: string) => void = (message) => console.warn(message),
  ) {}

  /** Distinct keys currently held. */
  get size(): number {
    return this.#entries.size;
  }

  /** Keys evicted by the cap over the life of the buffer. */
  get dropped(): number {
    return this.#dropped;
  }

  /** Entries given up on after `MAX_REPLAY_ATTEMPTS` failed replays. */
  get abandoned(): number {
    return this.#abandoned;
  }

  /** Add `n` to `key`, returning the count now held for it. */
  add(key: string, n = 1): number {
    const entry = this.#entries.get(key);
    if (entry) {
      entry.count += n;
      return entry.count;
    }
    if (this.#entries.size >= this.maxKeys) {
      const oldest = this.#entries.keys().next().value;
      if (oldest !== undefined) this.#entries.delete(oldest);
      this.#dropped += 1;
      if (!this.#overflowLogged) {
        this.#overflowLogged = true;
        this.warn(
          `[${this.label}] counter buffer is full (${this.maxKeys} keys); dropping the oldest until Redis is back`,
        );
      }
    }
    this.#entries.set(key, { count: n, expireSeconds: null, attempts: 0 });
    return n;
  }

  /**
   * Return a replayed entry that rejected. Merged with any count that arrived
   * for the key during the flush, and carrying the failed try. The merged
   * entry takes the higher attempt count, so a fresh hit that lands on a key
   * about to be given up on is dropped with it rather than reviving it.
   *
   * Map order after a put-back is slightly off: hits that arrived during the
   * failed flush sit ahead of the put-backs, so at the cap they are evicted
   * first even though they are newer. Acceptable — it only matters while the
   * buffer is both full and failing to flush, and the alternative is
   * re-inserting the whole map on every failed flush.
   */
  #putBack(entry: PendingIncrement): void {
    const attempts = entry.attempts + 1;
    if (attempts >= MAX_REPLAY_ATTEMPTS) {
      this.#abandoned += 1;
      return;
    }
    this.add(entry.key, entry.count);
    const held = this.#entries.get(entry.key);
    if (!held) return;
    held.attempts = Math.max(held.attempts, attempts);
    if (entry.expireSeconds !== null) held.expireSeconds = entry.expireSeconds;
  }

  /**
   * Remember a TTL for a key already held. The caller asks for one when its
   * INCR reported a fresh key; the flush applies it only if the key is fresh
   * in Redis too. A key not held here is ignored — there is nothing to attach
   * it to, and the caller's own EXPIRE will have gone to Redis directly.
   */
  expire(key: string, seconds: number): void {
    const entry = this.#entries.get(key);
    if (entry) entry.expireSeconds = seconds;
  }

  /** Everything held, in insertion order, leaving the buffer empty. */
  take(): PendingIncrement[] {
    const out: PendingIncrement[] = [];
    for (const [key, { count, expireSeconds, attempts }] of this.#entries) {
      out.push({ key, count, expireSeconds, attempts });
    }
    this.#entries.clear();
    return out;
  }

  /**
   * Write everything held, via `apply`, putting back whatever fails.
   *
   * Takes the whole buffer synchronously before the first await, so two
   * callers flushing at once cannot both write the same increment: the second
   * finds nothing to take. A failed entry goes back (see `#putBack`), so a
   * count that arrived for the same key during the flush is merged with it
   * rather than overwritten, and is dropped after `MAX_REPLAY_ATTEMPTS`. Never
   * rejects — every caller of this is fire-and-forget.
   */
  async flush(apply: (entry: PendingIncrement) => Promise<void>): Promise<void> {
    const pending = this.take();
    let putBack = 0;
    await Promise.allSettled(
      pending.map(async (entry) => {
        try {
          await apply(entry);
        } catch {
          putBack += 1;
          this.#putBack(entry);
        }
      }),
    );
    // A flush that landed ends the outage as far as this buffer can tell; the
    // next overflow is a new one and deserves its own line in the log. A flush
    // that put anything back is the same outage still going.
    if (putBack === 0) this.#overflowLogged = false;
  }
}
