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
 */

export const COUNTER_BUFFER_MAX_KEYS = 10_000;

export interface PendingIncrement {
  key: string;
  count: number;
  /** A TTL the caller asked for on this key, to apply if the flush creates it. */
  expireSeconds: number | null;
}

export class CounterBuffer {
  readonly #entries = new Map<string, { count: number; expireSeconds: number | null }>();
  #dropped = 0;
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
    this.#entries.set(key, { count: n, expireSeconds: null });
    return n;
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
    for (const [key, { count, expireSeconds }] of this.#entries) out.push({ key, count, expireSeconds });
    this.#entries.clear();
    // The outage is over as far as this buffer can tell; the next overflow is
    // a new one and deserves its own line in the log.
    this.#overflowLogged = false;
    return out;
  }

  /**
   * Write everything held, via `apply`, putting back whatever fails.
   *
   * Takes the whole buffer synchronously before the first await, so two
   * callers flushing at once cannot both write the same increment: the second
   * finds nothing to take. A failed entry goes back through `add`, so a count
   * that arrived for the same key during the flush is merged with it rather
   * than overwritten. Never rejects — every caller of this is fire-and-forget.
   */
  async flush(apply: (entry: PendingIncrement) => Promise<void>): Promise<void> {
    const pending = this.take();
    await Promise.allSettled(
      pending.map(async (entry) => {
        try {
          await apply(entry);
        } catch {
          this.add(entry.key, entry.count);
          if (entry.expireSeconds !== null) this.expire(entry.key, entry.expireSeconds);
        }
      }),
    );
  }
}
