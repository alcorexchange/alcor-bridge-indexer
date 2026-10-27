/**
 * When to try a failed job again, per key: each failure in a row doubles the wait.
 *
 * Freezing a deposit proof asks for a whole block's receipts, a heavy call on a
 * paid tier. While every BSC archive endpoint refused on 2026-10-27, three
 * deposits retried it on every 20-second poll for hours, and the retries were a
 * large part of what used the quotas up. A job that failed waits `firstMs`, then
 * twice that, up to `maxMs`; a success forgets the key.
 */

const FIRST_MS = 30_000;
const MAX_MS = 30 * 60_000;

export class RetryLater {
  private readonly firstMs: number;
  private readonly maxMs: number;
  private readonly next = new Map<string, { failures: number; at: number }>();

  constructor({ firstMs = FIRST_MS, maxMs = MAX_MS } = {}) {
    this.firstMs = firstMs;
    this.maxMs = maxMs;
  }

  /** Whether `key` may be tried now. */
  due(key: string, now = Date.now()): boolean {
    return (this.next.get(key)?.at ?? 0) <= now;
  }

  /** Record a failure; returns how long `key` now waits, in ms. */
  failed(key: string, now = Date.now()): number {
    const failures = (this.next.get(key)?.failures ?? 0) + 1;
    const wait = Math.min(this.firstMs * 2 ** (failures - 1), this.maxMs);
    this.next.set(key, { failures, at: now + wait });
    return wait;
  }

  succeeded(key: string): void {
    this.next.delete(key);
  }
}
