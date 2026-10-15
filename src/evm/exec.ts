/**
 * Execution-layer JSON-RPC.
 *
 * Every call goes through here so the fallback across a chain's endpoints applies
 * to every lookup a proof depends on — a call that reached only one node is a call
 * that can be answered "no" by a node which simply pruned the data.
 *
 * The endpoints used to be global configuration, which was true while one process
 * followed one chain. It stopped being true when one instance had to follow two:
 * the second follower would have quietly asked the first chain's nodes about the
 * second chain's blocks and been told, correctly, that they do not exist. So the
 * list is a parameter now, defaulting to the active chain's so nothing that reads
 * it implicitly had to change.
 *
 * `parked` stays shared: refusing is a property of an endpoint, not of whoever
 * asked.
 */
import { keccak_256 } from '@noble/hashes/sha3';

import { jsonRpc, jsonRpcAny, HttpError } from '../net/fetchJson.ts';
import { EXEC_URLS } from '../config.ts';

/**
 * An endpoint that refused, and when it may be asked again.
 *
 * A gateway that answers 429 means it, and asking it again on the next poll is
 * how one refusal becomes a steady stream of them: the rotation exists for
 * redundancy, not for spreading a rate limit around. Parking costs exactly that
 * redundancy, which is why the wait is short and why an exhausted rotation
 * ignores it — a node that might refuse still beats no node at all.
 */
const parked = new Map<string, number>();

function openEndpoints(urls: string[] = EXEC_URLS): string[] {
  const now = Date.now();
  const open = urls.filter((url) => (parked.get(url) ?? 0) <= now);
  return open.length ? open : urls;
}

/**
 * How long a refusal keeps an endpoint out of the rotation.
 *
 * A rate limit passes, so the wait is short. A 401/403 does not: Blast API
 * answered 403 with "no longer available" on every call for two days and was
 * asked again every single poll, because the original condition covered 429 and
 * 5xx and nothing else. A dead host should cost one request an hour, not one per
 * poll, and the long park is what makes a stale registry entry merely wasteful
 * instead of a permanent error in the log.
 */
const PARK_MS = 60_000;
const PARK_REFUSED_MS = 60 * 60_000;

function park(url: string, err: unknown): void {
  if (!(err instanceof HttpError)) return;
  if (err.status === 401 || err.status === 403) {
    parked.set(url, Date.now() + PARK_REFUSED_MS);
  } else if (err.status === 429 || err.status >= 500) {
    parked.set(url, Date.now() + PARK_MS);
  }
}

export const execRpc = (
  method: string,
  params: unknown[],
  urls: string[] = EXEC_URLS,
): Promise<any> => jsonRpcAny(openEndpoints(urls), method, params);

/**
 * The head every endpoint agrees exists.
 *
 * Asking one node for the head and another for logs up to it is a race the
 * second node loses: it answers `block range extends beyond current head`, and
 * a scanner that treats that as a failure stops advancing. Nodes are seconds
 * apart, so the lowest head is the one a multi-endpoint read can safely name.
 */
export async function execHead(urls: string[] = EXEC_URLS): Promise<number> {
  const heads: number[] = [];
  for (const url of openEndpoints(urls)) {
    try {
      heads.push(Number(await jsonRpc(url, 'eth_blockNumber', [])));
    } catch (err) {
      // A node that will not answer does not get a vote.
      park(url, err);
    }
  }
  if (!heads.length) throw new Error('no execution endpoint answered eth_blockNumber');
  return Math.min(...heads);
}

/**
 * `eth_getLogs`, with `confirmEmpty` deciding what an empty answer means.
 *
 * A node that has pruned its log index for a range does not say so. It answers
 * `[]`, and an empty array is indistinguishable from "nothing happened there" —
 * which is worse than the `null` a pruned receipt returns, because `null` at
 * least looks like an absence. Measured on Sepolia: for the block that released
 * withdrawal 1, one public endpoint returned no logs while another returned the
 * event, and the receipt for that transaction carried it on both. So a search
 * through history passes `confirmEmpty` and keeps asking until somebody has it.
 *
 * At the head there is nothing to have pruned, and almost every poll is empty.
 * Confirming those with a second request doubles the traffic of a scanner that
 * never stops running, in exchange for a fact nobody doubted — which is how the
 * rotation's second endpoint reached its rate limit. There, one clean answer is
 * the answer.
 *
 * Either way an endpoint that errors while another answered is not a failure.
 * Heads drift by a block between nodes, and a scan that stops on the laggard's
 * complaint leaves settled crossings looking open.
 */
export async function execLogs(
  filter: unknown,
  opts: { confirmEmpty?: boolean } = {},
  urls: string[] = EXEC_URLS,
): Promise<any[]> {
  let answered = false;
  let lastError: unknown = null;

  for (const url of openEndpoints(urls)) {
    try {
      const logs = await jsonRpc(url, 'eth_getLogs', [filter]);
      if (!Array.isArray(logs)) continue;
      answered = true;
      if (logs.length || !opts.confirmEmpty) return logs;
    } catch (err) {
      lastError = err;
      park(url, err);
    }
  }
  if (!answered && lastError) throw lastError;
  return [];
}

/**
 * One chain's endpoints, bundled.
 *
 * A follower holds one of these instead of reaching for the module's functions,
 * which is the whole difference between two followers in one process and two
 * followers asking the same nodes about different chains.
 */
export type Exec = {
  urls: string[];
  rpc(method: string, params: unknown[]): Promise<any>;
  head(): Promise<number>;
  logs(filter: unknown, opts?: { confirmEmpty?: boolean }): Promise<any[]>;
};

export const execFor = (urls: string[]): Exec => ({
  urls,
  rpc: (method, params) => execRpc(method, params, urls),
  head: () => execHead(urls),
  logs: (filter, opts) => execLogs(filter, opts, urls),
});

/** The active chain's, for everything that predates the parameter. */
export const activeExec: Exec = execFor(EXEC_URLS);

/**
 * A function selector: the first four bytes of keccak(signature).
 *
 * Here rather than beside each caller because three modules had already computed
 * it for themselves, identically, and a fourth was about to. `eth_call` is the
 * only thing it is ever used for, which is what makes this its home.
 */
export const selector = (signature: string): string =>
  '0x' + Buffer.from(keccak_256(new TextEncoder().encode(signature))).toString('hex').slice(0, 8);
