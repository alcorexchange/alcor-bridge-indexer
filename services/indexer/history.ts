/**
 * Filling in what a row is missing, from our own action history (actions.ts).
 *
 * The settlement stream and the relayers' crossings files are how a row is
 * normally completed. What they miss — a relayer that did not record a step,
 * a credit the stream could not decode — comes out of the tables with a status
 * and an amount and nothing to show a person: no token, no transaction on
 * either side. Each chain's history has kept the actions, so a row that lacks
 * something is completed from there, once, and then never looked at again
 * because it lacks nothing.
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

import { execFor } from '../../src/evm/exec.ts';
import { chainOfDomain, SETTLEMENT_CHAIN, type IndexerConfig } from './config.ts';
import { BOOKED, Store, depositKey, externalToken, type ChainAction, type TransferRow } from './db.ts';

/** How far before the row's own time the action is searched for. */
const SLACK_SECONDS = 24 * 3600;

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
export function applyBurns(store: Store, rows: TransferRow[], wdlogs: ChainAction[]): number {
  const byId = new Map(wdlogs.map((a) => [Number(a.data.id), a]));
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
      src_time: a.time,
    });
    filled++;
  }
  return filled;
}

/** What the ledger's `credit` says about a deposit, applied to its row. */
export function applyCredits(store: Store, rows: TransferRow[], credits: ChainAction[]): number {
  const byKey = new Map(credits.map((a) => [depositKey(String(a.data.domain), Number(a.data.nonce)), a]));
  let filled = 0;
  for (const row of rows) {
    const a = byKey.get(row.key);
    if (!a) continue;
    const d = a.data;
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
      dst_time: a.time,
    });
    filled++;
  }
  return filled;
}

/** What an Antelope vault's `deplog` says about a deposit: where it started. */
export function applyDeplogs(store: Store, domain: string, rows: TransferRow[], deplogs: ChainAction[]): number {
  const byNonce = new Map(deplogs.map((a) => [Number(a.data.nonce), a]));
  let filled = 0;
  for (const row of rows) {
    const a = byNonce.get(row.ref);
    if (!a || row.domain !== domain) continue;
    const d = a.data;
    store.upsertTransfer({
      key: row.key,
      direction: 'deposit',
      ref: row.ref,
      status: row.status,
      evm_address: String(d.from),
      memo: d.memo ? String(d.memo) : undefined,
      src_tx: a.trx_id,
      src_block: a.block_num,
      src_time: a.time,
    });
    filled++;
  }
  return filled;
}

/**
 * An Antelope vault's `release` and `expire` carry the withdrawal's packed payload
 * in `data`; its id is the first eight bytes.
 */
export function applySettlements(store: Store, domain: string, rows: TransferRow[], actions: ChainAction[]): number {
  const byId = new Map<number, ChainAction>();
  for (const a of actions) {
    const data = String(a.data.data ?? '');
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
      dst_time: a.time,
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
 * nothing is missing, which is the steady state — no row, no query.
 */
export async function backfillFromHistory(cfg: IndexerConfig, store: Store): Promise<number> {
  let filled = 0;
  filled += await backfillEvmSources(cfg, store);

  const missingCredit = depositsMissingCredit(store);
  if (missingCredit.length) {
    const after = Math.min(...missingCredit.map((r) => r.src_time)) - SLACK_SECONDS;
    filled += applyCredits(store, missingCredit, store.actionsOf(SETTLEMENT_CHAIN, 'credit', after));
  }
  const missingBurn = withdrawalsMissingBurn(store);
  if (missingBurn.length) {
    const after = Math.min(...missingBurn.map((r) => r.src_time)) - SLACK_SECONDS;
    filled += applyBurns(store, missingBurn, store.actionsOf(SETTLEMENT_CHAIN, 'wdlog', after));
  }

  // Each Antelope chain's own history: its vault's deposits and settlements.
  const missingDeplog = antelopeRowsMissing(cfg, store, 'deposit', 'src_tx');
  const missingRelease = antelopeRowsMissing(cfg, store, 'withdrawal', 'dst_tx');
  for (const { chain } of cfg.antelope) {
    const deposits = missingDeplog.filter((r) => r.domain === chain.domain);
    if (deposits.length) {
      const after = Math.min(...deposits.map((r) => r.src_time)) - SLACK_SECONDS;
      filled += applyDeplogs(store, chain.domain, deposits, store.actionsOf(chain.id, 'deplog', after));
    }
    const withdrawals = missingRelease.filter((r) => r.domain === chain.domain);
    if (withdrawals.length) {
      const after = Math.min(...withdrawals.map((r) => r.src_time)) - SLACK_SECONDS;
      const settled = [...store.actionsOf(chain.id, 'release', after), ...store.actionsOf(chain.id, 'expire', after)];
      filled += applySettlements(store, chain.domain, withdrawals, settled);
    }
  }
  return filled;
}
