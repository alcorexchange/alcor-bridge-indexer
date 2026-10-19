/**
 * Finding the NEAR vault's receipts: its transactions through FastNEAR's
 * account history API (`txApi`), each read back from the RPC. Shared by the
 * indexer (labels for crossings) and the NEAR relayer (what to prove on Telos).
 * Nothing found here is trusted for money: Telos checks every outcome against
 * a head its light client verified.
 */
import { parseNearLog, type NearLog } from './logs.ts';
import { nearRpc } from './rpc.ts';

/** Where to look: NEAR RPC endpoints and FastNEAR's transaction API. */
export type NearSource = { rpc: string[]; txApi: string };

type AccountTx = { transaction_hash: string; tx_block_height: number };

async function txApi(near: NearSource, path: string, body: unknown): Promise<any> {
  const res = await fetch(`${near.txApi}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`near: ${near.txApi}${path} -> HTTP ${res.status}`);
  return res.json();
}

/**
 * The height FastNEAR has indexed the chain to. Its account history answers
 * for blocks past that with fewer transactions and no error, so nothing past
 * it may be read as complete.
 */
export async function indexedHeight(near: NearSource): Promise<number> {
  const res = await fetch(`${near.txApi}/status`, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`near: ${near.txApi}/status -> HTTP ${res.status}`);
  const s = (await res.json()) as { latest_block_height?: number };
  if (!Number.isSafeInteger(s.latest_block_height)) throw new Error(`near: ${near.txApi}/status names no height`);
  return Number(s.latest_block_height);
}

/** Who signed each transaction: the RPC finds a transaction by its hash AND its signer. */
async function signersOf(near: NearSource, hashes: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < hashes.length; i += 20) {
    const page = await txApi(near, '/v0/transactions', { tx_hashes: hashes.slice(i, i + 20) });
    for (const t of page.transactions ?? []) out.set(String(t.transaction.hash), String(t.transaction.signer_id));
  }
  return out;
}

/** The vault's transactions from `from` (inclusive) up to `to`, oldest first, through FastNEAR's history API. */
async function vaultTxs(near: NearSource, vault: string, from: number, to: number): Promise<AccountTx[]> {
  const out: AccountTx[] = [];
  let resume: string | undefined;
  for (;;) {
    const page = (await txApi(near, '/v0/account', {
      account_id: vault, desc: false, limit: 200,
      from_tx_block_height: from, to_tx_block_height: to,
      ...(resume ? { resume_token: resume } : {}),
    })) as { account_txs: AccountTx[]; resume_token?: string };
    out.push(...page.account_txs);
    if (!page.resume_token || !page.account_txs.length) return out;
    resume = page.resume_token;
  }
}

const blockTimes = new Map<string, { height: number; time: number }>();
async function blockOf(near: NearSource, hash: string): Promise<{ height: number; time: number }> {
  const hit = blockTimes.get(hash);
  if (hit) return hit;
  const h = (await nearRpc(near.rpc, 'block', { block_id: hash })).header;
  const b = { height: Number(h.height), time: Math.floor(Number(BigInt(h.timestamp_nanosec) / 1_000_000_000n)) };
  if (blockTimes.size > 1000) blockTimes.clear();
  blockTimes.set(hash, b);
  return b;
}

export type NearVaultTx = {
  hash: string;
  /** The block the transaction was included in; its receipts may run a few blocks later. */
  txHeight: number;
  /** The vault's log lines in it, from its own successful receipts, oldest first. */
  logs: { log: NearLog; height: number; time: number; receipt: string; blockHash: string; index: number }[];
};

/**
 * The vault's transactions included in blocks `from`..`to`, oldest first, with
 * what its logs say. Only the vault's own outcomes count, and only those that
 * succeeded: a failed receipt keeps its logs and none of its state.
 */
export async function* nearVaultTxs(near: NearSource, vault: string, from: number, to: number): AsyncGenerator<NearVaultTx> {
  const txs = await vaultTxs(near, vault, from, to);
  const signers = await signersOf(near, txs.map((t) => t.transaction_hash));
  for (const t of txs) {
    const signer = signers.get(t.transaction_hash);
    if (!signer) throw new Error(`near: ${near.txApi} does not know who signed ${t.transaction_hash}`);
    const status = await nearRpc(near.rpc, 'EXPERIMENTAL_tx_status', {
      tx_hash: t.transaction_hash, sender_account_id: signer, wait_until: 'FINAL',
    });
    const logs: NearVaultTx['logs'] = [];
    for (const o of status.receipts_outcome ?? []) {
      if (o.outcome.executor_id !== vault || !('SuccessValue' in (o.outcome.status ?? {}))) continue;
      for (const [index, line] of (o.outcome.logs as string[]).entries()) {
        const log = parseNearLog(line);
        if (log) logs.push({ log, ...(await blockOf(near, o.block_hash)), receipt: String(o.id), blockHash: String(o.block_hash), index });
      }
    }
    yield { hash: String(t.transaction_hash), txHeight: Number(t.tx_block_height), logs };
  }
}

