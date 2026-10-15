/**
 * Antelope HTTP RPC, retrying, with the endpoint list from the chain registry.
 *
 * This exists because the same twenty-line `rpc()` — POST, exponential backoff,
 * retry transport faults and 5xx, give up on 4xx — had been copied into five
 * scripts. The copies had already drifted: some take the first endpoint from the
 * registry and ignore the fallbacks, some hardcode a URL, and the reason for
 * retrying at all (a twenty-minute catch-up discarded over one `ECONNRESET`)
 * is written out in two of them and absent from the rest.
 *
 * Built on `fetchJson`, so a request that stalls behind DPI falls back through
 * the local tunnel before it is ever counted as a failure.
 *
 * Only transport failures and 5xx are retried against the SAME endpoint. A 4xx
 * means repeating the request changes nothing — but it does not mean the request
 * is wrong, and that distinction costs an afternoon to learn: a node with
 * `block-log-retain-blocks = 172800` answers HTTP 400 "Unknown Block" for
 * anything older than a day, which is retention policy wearing the clothes of a
 * bad request. So a 4xx moves on to the next endpoint and is only raised once
 * every endpoint has given one.
 */

import { fetchJson, HttpError } from './fetchJson.ts';

/** Anything carrying an ordered endpoint list — `SavannaChain` fits as is. */
export type RpcEndpoints = { rpc: string[] };

const BACKOFF_START_MS = 500;

export async function antelopeRpc(
  chain: RpcEndpoints,
  path: string,
  body: unknown = {},
  attempts = 5,
): Promise<any> {
  let wait = BACKOFF_START_MS;
  let lastError: unknown;
  let firstRefusal: HttpError | undefined;

  for (let i = 1; i <= attempts; i++) {
    // Endpoints in registry order, so a healthy fallback answers within the
    // same attempt rather than after the whole backoff has run out.
    let allRefused = true;
    for (const url of chain.rpc) {
      try {
        return await fetchJson(url + path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
      } catch (err) {
        if (err instanceof HttpError && err.status < 500) {
          firstRefusal ??= err;
        } else {
          allRefused = false;
        }
        lastError = err;
      }
    }
    // Every endpoint gave a definite no. Waiting will not change their minds.
    if (allRefused && firstRefusal) throw firstRefusal;
    if (i < attempts) {
      await new Promise((r) => setTimeout(r, wait));
      wait *= 2;
    }
  }
  throw lastError;
}

export type ChainInfo = {
  head_block_num: number;
  head_block_time: string;
  last_irreversible_block_num: number;
};

export const getInfo = (chain: RpcEndpoints): Promise<ChainInfo> =>
  antelopeRpc(chain, '/v1/chain/get_info');

export const getBlock = (chain: RpcEndpoints, blockNumOrId: number | string): Promise<any> =>
  antelopeRpc(chain, '/v1/chain/get_block', { block_num_or_id: blockNumOrId });

export type TableQuery = {
  code: string;
  /** Defaults to `code`, which is what every table in this bridge uses. */
  scope?: string;
  table: string;
  /** Rows per request, not rows in total: pagination is followed to the end. */
  limit?: number;
  lower_bound?: string | number;
};

/**
 * Every row of a table, following `more` rather than trusting one page.
 *
 * A caller that reads `rows` from a single request is correct until the table
 * outgrows the page — and a bridge table that silently stops listing the newest
 * withdrawal is exactly the kind of thing that reads as "nothing to do".
 */
export async function getTableRows<T = any>(chain: RpcEndpoints, q: TableQuery): Promise<T[]> {
  const out: T[] = [];
  let lower = q.lower_bound;

  for (;;) {
    const page = await antelopeRpc(chain, '/v1/chain/get_table_rows', {
      json: true,
      code: q.code,
      scope: q.scope ?? q.code,
      table: q.table,
      limit: q.limit ?? 100,
      ...(lower !== undefined ? { lower_bound: lower } : {}),
    });
    out.push(...(page.rows as T[]));
    if (!page.more || !page.next_key) return out;
    lower = page.next_key;
  }
}

/**
 * Every scope a table has rows in.
 *
 * For a table scoped by something the caller cannot list up front — a chain id,
 * an account — this is the only way to find them all. Scopes come back as NAMES,
 * whatever they were written as: chain id 11155111 reads `........pcveb`. A
 * caller that scoped by a number turns it back with `nameToUint64`.
 */
export async function getScopes(chain: RpcEndpoints, code: string, table: string): Promise<string[]> {
  const out: string[] = [];
  let lower: string | undefined;

  for (;;) {
    const page = await antelopeRpc(chain, '/v1/chain/get_table_by_scope', {
      code,
      table,
      limit: 100,
      ...(lower !== undefined ? { lower_bound: lower } : {}),
    });
    out.push(...(page.rows as { scope: string }[]).map((r) => r.scope));
    if (!page.more) return out;
    lower = page.more;
  }
}
