/**
 * Filling in what a row is missing, from the chains' action history.
 *
 * The stream and the crossings file are how a row is normally completed, and
 * both only know what went by while they were watched. A crossing made before
 * either existed — or while the process was down — comes out of the tables
 * with a status and an amount and nothing to show a person: no token, no
 * transaction on either side. Hyperion has kept the actions, so a row that
 * lacks something is completed from there, once, and then never asked about
 * again because it lacks nothing.
 *
 *   credit   on Telos: the token, the beneficiary, the transaction that credited
 *   wdlog    on Telos: the transaction that burned a withdrawal
 *   deplog   on an Antelope chain: the depositor and the deposit's own transaction
 *   release  on an Antelope chain: the transaction that paid a withdrawal
 *   receipt  on an EVM chain: the block and time of a deposit known only by its hash
 *
 * Only booked or settled rows are looked at, so a crossing still in flight is
 * left to the stream, which is faster than a history query by a minute.
 */

import { fetchJson } from '../../src/net/fetchJson.ts';
import { execFor } from '../../src/evm/exec.ts';
import { getTableRows } from '../../src/net/antelope.ts';
import { antelopeVaults } from '../../src/chains/antelope.ts';
import { chainOfDomain, type IndexerConfig } from './config.ts';
import { BOOKED, Store, depositKey, externalToken, type TransferRow } from './db.ts';

const PAGE = 100;
/** How far before the row's own time the action is searched for. */
const SLACK_SECONDS = 24 * 3600;

export type HistoryAction = {
  block_num: number;
  trx_id: string;
  timestamp: string;
  act: { name: string; data: Record<string, any> };
};

/** Every `account::action` after `after`, from the first Hyperion host that answers. */
export async function hyperionActions(
  hosts: string[],
  account: string,
  action: string,
  afterSeconds: number,
): Promise<HistoryAction[]> {
  if (!hosts.length) throw new Error('no Hyperion endpoint configured');
  const after = new Date(afterSeconds * 1000).toISOString();
  const failures: string[] = [];
  for (const host of hosts) {
    try {
      const out: HistoryAction[] = [];
      for (let skip = 0; ; skip += PAGE) {
        const url =
          `${host.replace(/\/$/, '')}/v2/history/get_actions?account=${account}` +
          `&filter=${account}:${action}&after=${after}&sort=asc&limit=${PAGE}&skip=${skip}`;
        const body = (await fetchJson(url)) as { actions?: HistoryAction[] };
        if (!Array.isArray(body.actions)) throw new Error('no actions array');
        out.push(...body.actions);
        if (body.actions.length < PAGE) return out;
      }
    } catch (err) {
      failures.push(`${host}: ${(err as Error).message}`);
    }
  }
  throw new Error(`no Hyperion endpoint served ${account}::${action} — ${failures.join('; ')}`);
}

const seconds = (timestamp: string) => Math.floor(Date.parse(`${timestamp}Z`) / 1000);

/** Booked deposits with no token or no crediting transaction. */
function depositsMissingCredit(store: Store): TransferRow[] {
  return store.db
    .prepare(
      `SELECT * FROM transfers WHERE direction = 'deposit'
         AND status IN (${BOOKED.map((s) => `'${s}'`).join(', ')})
         AND (token IS NULL OR dst_tx IS NULL)`,
    )
    .all() as TransferRow[];
}

/** Withdrawals with no burning transaction; the burn is on Telos whatever the route. */
function withdrawalsMissingBurn(store: Store): TransferRow[] {
  return store.db
    .prepare(`SELECT * FROM transfers WHERE direction = 'withdrawal' AND src_tx IS NULL`)
    .all() as TransferRow[];
}

/** Rows on an Antelope domain with no transaction, block or counterparty on that side. */
function antelopeRowsMissing(cfg: IndexerConfig, store: Store, direction: 'deposit' | 'withdrawal', column: 'src_tx' | 'dst_tx'): TransferRow[] {
  const counterparty = direction === 'deposit' ? ' OR evm_address IS NULL OR src_block = 0' : '';
  const rows = store.db
    .prepare(`SELECT * FROM transfers WHERE direction = ? AND (${column} IS NULL${counterparty}) AND status IN ('credited','parked','forwarded','bounced','released','expired','refunded')`)
    .all(direction) as TransferRow[];
  return rows.filter((r) => chainOfDomain(cfg, r.domain)?.kind === 'antelope');
}

/** The ledger's `wdlog`, which rode in the transaction that burned the withdrawal. */
export function applyBurns(store: Store, rows: TransferRow[], wdlogs: HistoryAction[]): number {
  const byId = new Map(wdlogs.map((a) => [Number(a.act.data.id), a]));
  let filled = 0;
  for (const row of rows) {
    const a = byId.get(row.ref);
    if (!a) continue;
    store.upsertTransfer({
      key: row.key,
      direction: 'withdrawal',
      ref: row.ref,
      status: row.status,
      src_tx: a.trx_id,
      src_block: a.block_num,
      src_time: seconds(a.timestamp),
    });
    filled++;
  }
  return filled;
}

/** What the ledger's `credit` says about a deposit, applied to its row. */
export function applyCredits(store: Store, rows: TransferRow[], credits: HistoryAction[]): number {
  const byKey = new Map(credits.map((a) => [depositKey(String(a.act.data.domain), Number(a.act.data.nonce)), a]));
  let filled = 0;
  for (const row of rows) {
    const a = byKey.get(row.key);
    if (!a) continue;
    const d = a.act.data;
    store.upsertTransfer({
      key: row.key,
      direction: 'deposit',
      ref: row.ref,
      status: row.status,
      token: externalToken(String(d.domain), String(d.ext_token)),
      account: String(d.beneficiary),
      amount: String(d.canonical),
      memo: d.memo ? String(d.memo) : undefined,
      dst_tx: a.trx_id,
      dst_block: a.block_num,
      dst_time: seconds(a.timestamp),
    });
    filled++;
  }
  return filled;
}

/** What an Antelope vault's `deplog` says about a deposit: where it started. */
export function applyDeplogs(store: Store, domain: string, rows: TransferRow[], deplogs: HistoryAction[]): number {
  const byNonce = new Map(deplogs.map((a) => [Number(a.act.data.nonce), a]));
  let filled = 0;
  for (const row of rows) {
    const a = byNonce.get(row.ref);
    if (!a || row.domain !== domain) continue;
    const d = a.act.data;
    store.upsertTransfer({
      key: row.key,
      direction: 'deposit',
      ref: row.ref,
      status: row.status,
      evm_address: String(d.from),
      memo: d.memo ? String(d.memo) : undefined,
      src_tx: a.trx_id,
      src_block: a.block_num,
      src_time: seconds(a.timestamp),
    });
    filled++;
  }
  return filled;
}

/**
 * An Antelope vault's `release` and `expire` carry the withdrawal's packed payload
 * in `data`; its id is the first eight bytes.
 */
export function applySettlements(store: Store, domain: string, rows: TransferRow[], actions: HistoryAction[]): number {
  const byId = new Map<number, HistoryAction>();
  for (const a of actions) {
    const data = String(a.act.data.data ?? '');
    if (data.length < 16) continue;
    byId.set(Number(Buffer.from(data.slice(0, 16), 'hex').readBigUInt64LE(0)), a);
  }
  let filled = 0;
  for (const row of rows) {
    const a = byId.get(row.ref);
    if (!a || row.domain !== domain) continue;
    store.upsertTransfer({
      key: row.key,
      direction: 'withdrawal',
      ref: row.ref,
      status: row.status,
      dst_tx: a.trx_id,
      dst_block: a.block_num,
      dst_time: seconds(a.timestamp),
    });
    filled++;
  }
  return filled;
}

/**
 * An EVM deposit known only by its hash: its block and the block's time, from
 * the receipt. The tables on Telos record when it was credited, which is not
 * when it happened.
 */
async function backfillEvmSources(cfg: IndexerConfig, store: Store): Promise<number> {
  const rows = store.db
    .prepare(`SELECT * FROM transfers WHERE direction = 'deposit' AND src_block = 0 AND src_tx IS NOT NULL`)
    .all() as TransferRow[];
  let filled = 0;
  for (const row of rows) {
    const source = chainOfDomain(cfg, row.domain);
    if (source?.kind !== 'evm') continue;
    const exec = execFor(source.exec);
    const receipt = await exec.rpc('eth_getTransactionReceipt', [row.src_tx]);
    if (!receipt) continue;
    const block = await exec.rpc('eth_getBlockByNumber', [receipt.blockNumber, false]);
    if (!block) continue;
    store.upsertTransfer({
      key: row.key,
      direction: 'deposit',
      ref: row.ref,
      status: row.status,
      src_block: Number(BigInt(receipt.blockNumber)),
      src_time: Number(BigInt(block.timestamp)),
    });
    filled++;
  }
  return filled;
}

/**
 * One pass: every row that lacks something, completed from history. Cheap when
 * nothing is missing, which is the steady state — no row, no request.
 */
export async function backfillFromHistory(cfg: IndexerConfig, store: Store): Promise<number> {
  let filled = 0;
  const bridge = cfg.savanna.accounts.bridge;
  filled += await backfillEvmSources(cfg, store);

  const missingCredit = depositsMissingCredit(store);
  if (missingCredit.length) {
    const after = Math.min(...missingCredit.map((r) => r.src_time)) - SLACK_SECONDS;
    filled += applyCredits(store, missingCredit, await hyperionActions(cfg.history, bridge, 'credit', after));
  }
  const missingBurn = withdrawalsMissingBurn(store);
  if (missingBurn.length) {
    const after = Math.min(...missingBurn.map((r) => r.src_time)) - SLACK_SECONDS;
    filled += applyBurns(store, missingBurn, await hyperionActions(cfg.history, bridge, 'wdlog', after));
  }

  if (!cfg.antelope.length) return filled;
  const missingDeplog = antelopeRowsMissing(cfg, store, 'deposit', 'src_tx');
  const missingRelease = antelopeRowsMissing(cfg, store, 'withdrawal', 'dst_tx');
  if (!missingDeplog.length && !missingRelease.length) return filled;

  // Which vault pays each Antelope domain, from the ledger's own routes.
  const vaults = antelopeVaults(await getTableRows(cfg.savanna, { code: bridge, table: 'routes' }));

  for (const [domain, { account: vault }] of vaults) {
    // Each chain's own Hyperion; a domain this instance does not follow is skipped.
    const history = cfg.antelope.find((a) => a.chain.domain === domain)?.history;
    if (!history) continue;
    const deposits = missingDeplog.filter((r) => r.domain === domain);
    if (deposits.length) {
      const after = Math.min(...deposits.map((r) => r.src_time)) - SLACK_SECONDS;
      filled += applyDeplogs(store, domain, deposits, await hyperionActions(history, vault, 'deplog', after));
    }
    const withdrawals = missingRelease.filter((r) => r.domain === domain);
    if (withdrawals.length) {
      const after = Math.min(...withdrawals.map((r) => r.src_time)) - SLACK_SECONDS;
      const [released, expired] = await Promise.all([
        hyperionActions(history, vault, 'release', after),
        hyperionActions(history, vault, 'expire', after),
      ]);
      filled += applySettlements(store, domain, withdrawals, [...released, ...expired]);
    }
  }
  return filled;
}
