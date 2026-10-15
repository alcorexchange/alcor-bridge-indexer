/**
 * A value that is expensive to read from chains and changes slowly.
 *
 * Recomputed at most every `ttlMs`, and never twice at once: a burst of
 * requests arriving together while it is stale shares one computation instead
 * of each sending its own round of RPC calls.
 *
 * `ttlMs` may depend on the value. A read that came back partial — one chain
 * did not answer — is worth keeping only briefly: held for the full time, one
 * failed request turns into a minute of wrong numbers for every visitor.
 */
export function memo<T>(ttlMs: number | ((value: T) => number), compute: () => Promise<T>): () => Promise<T> {
  let cached: { until: number; value: T } | null = null;
  let inflight: Promise<T> | null = null;
  return () => {
    if (cached && Date.now() < cached.until) return Promise.resolve(cached.value);
    inflight ??= compute()
      .then((value) => {
        const ttl = typeof ttlMs === 'function' ? ttlMs(value) : ttlMs;
        cached = { until: Date.now() + ttl, value };
        return value;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  };
}
