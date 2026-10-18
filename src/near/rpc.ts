/**
 * NEAR JSON-RPC, the little the bridge reads: view calls on the vault.
 * Endpoints are tried in order; a view is read-only, so any honest node will do,
 * and whatever is read is checked again by the contract when it matters.
 */
export async function nearRpc(urls: string[], method: string, params: unknown): Promise<any> {
  let last: unknown;
  for (const url of urls) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(20_000),
      });
      const j = await r.json();
      if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error).slice(0, 400)}`);
      return j.result;
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

/** A view method's JSON result. */
export async function nearView<T>(urls: string[], account: string, method: string, args: unknown = {}): Promise<T> {
  const r = await nearRpc(urls, 'query', {
    request_type: 'call_function',
    finality: 'final',
    account_id: account,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
  });
  return JSON.parse(Buffer.from(r.result).toString('utf8')) as T;
}
