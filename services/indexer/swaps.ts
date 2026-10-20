/**
 * Swaps on the way: `bridgeroute`'s orders, read from its history, and what a
 * crossing says about the one its payout made.
 *
 * On Telos an order may deliver to another chain — the token bought, or the
 * one that arrived going back — through bridgehop, in the transaction that
 * ended the order. The withdrawal that carries it on is the one opened in that
 * transaction, which is how a swap names it (`onward`).
 *
 * A crossing that ends in a swap is paid out to bridgeroute, and the contract
 * makes an order of it in that same transaction — `opened`, or, for a payout
 * it pays on at once, `closed` right there. So the transaction a transfer row
 * already knows as its `dst_tx` (the release on WAX, the forward on Telos) is
 * the key that joins the crossing to its order, and nothing on chain needs to
 * name the crossing.
 *
 * The contract erases an order when it ends; Hyperion keeps both actions, so
 * they are read from there, a page at a time, behind a cursor per chain.
 *
 * An action is stored only in the shape the contract declares. A Hyperion host
 * with a stale ABI once served `opened` with other fields; it is passed over,
 * and a row it wrote is read again.
 */

import { ANTELOPE_SWAPS, ROUTE_MEMO } from '../../src/chains/swaps.ts';
import { SETTLEMENT_CHAIN, type IndexerConfig } from './config.ts';
import type { Store, SwapPayment, SwapRow } from './db.ts';
import { hyperionActions, type HistoryAction } from './history.ts';

/** Re-read this much before each cursor: Hyperion indexes a block a little after it is produced. */
const OVERLAP_SECONDS = 120;
/**
 * Where a chain with no cursor yet starts: as far back as an order can still be
 * open. Not the epoch — Hyperion refuses an ascending query from more than 90
 * days ago — and nothing older could change how a crossing reads now.
 */
const FIRST_LOOK_SECONDS = ROUTE_MEMO.maxWait;
/**
 * How far back a quiet chain keeps looking: the cursor follows the newest
 * action seen, and with none it still moves up to an hour behind the clock —
 * far more than Hyperion takes to index a block, and never toward its limit.
 */
const QUIET_LOOK_SECONDS = 3600;

/** A chain where bridgeroute is deployed, and the Hyperion endpoints its history is read through. */
type SwapChain = { chain: string; account: string; history: string[] };

/** Telos and every Antelope chain this instance follows, where bridgeroute has an account. */
export function swapChains(cfg: IndexerConfig): SwapChain[] {
  const out: SwapChain[] = [];
  const telos = ANTELOPE_SWAPS[SETTLEMENT_CHAIN]?.route;
  if (telos) out.push({ chain: SETTLEMENT_CHAIN, account: telos, history: cfg.history });
  for (const a of cfg.antelope) {
    const route = ANTELOPE_SWAPS[a.chain.id]?.route;
    if (route) out.push({ chain: a.chain.id, account: route, history: a.history });
  }
  return out;
}

type ExtendedAsset = { quantity: string; contract: string };

/** `<quantity>@<contract>`, as the memos write a token and an amount of it. */
const written = (a: ExtendedAsset): string => `${a.quantity}@${a.contract}`;

const isText = (v: unknown): v is string => typeof v === 'string';
const isTokens = (v: any): boolean => isText(v?.quantity) && isText(v?.contract);

/** `opened` as bridgeroute declares it: id, to, back, in, least, deadline. */
export const wellFormedOpened = (d: Record<string, any>): boolean =>
  d.id !== undefined && isText(d.to) && isText(d.back) && isTokens(d.in) && isTokens(d.least) && isText(d.deadline);

/** `closed` as bridgeroute declares it: id, outcome, paid[{ to, tokens }]. */
export const wellFormedClosed = (d: Record<string, any>): boolean =>
  d.id !== undefined && isText(d.outcome) && Array.isArray(d.paid) && d.paid.every((p: any) => isText(p?.to) && isTokens(p?.tokens));

/** Unix seconds of an Antelope time, written with or without a zone and milliseconds. */
const seconds = (time: string): number => Math.floor(Date.parse(/Z$|[+-]\d\d:\d\d$/.test(time) ? time : `${time}Z`) / 1000);

/**
 * Record `opened` and `closed` actions of `chain`'s bridgeroute; opened first,
 * so a payout's own transaction wins. Returns how many were new: every read
 * overlaps the last, and the same actions come back each time.
 */
export function applySwapActions(store: Store, chain: string, opened: HistoryAction[], closed: HistoryAction[]): number {
  let fresh = 0;
  for (const a of opened) {
    const d = a.act.data;
    if (!wellFormedOpened(d)) continue;
    const row = {
      chain,
      id: Number(d.id),
      payout_tx: a.trx_id,
      recipient: d.to,
      back: d.back,
      input: written(d.in),
      least: written(d.least),
      deadline: seconds(d.deadline),
      opened_at: seconds(a.timestamp),
    };
    // Written again when what is stored differs: a row from a stale-ABI host is corrected.
    const stored = store.swapOf(chain, row.id);
    if (stored && stored.payout_tx === row.payout_tx && stored.recipient === row.recipient && stored.back === row.back &&
        stored.input === row.input && stored.least === row.least && stored.deadline === row.deadline) continue;
    fresh++;
    store.putSwapOpened(row);
  }
  for (const a of closed) {
    const d = a.act.data;
    if (!wellFormedClosed(d)) continue;
    if (store.swapOf(chain, Number(d.id))?.outcome) continue;
    fresh++;
    store.putSwapClosed({
      chain,
      id: Number(d.id),
      outcome: d.outcome,
      paid: (d.paid as { to: string; tokens: ExtendedAsset }[]).map((p) => ({ to: p.to, asset: written(p.tokens) })),
      tx: a.trx_id,
      at: seconds(a.timestamp),
    });
  }
  return fresh;
}

/**
 * Read every chain's new `opened` and `closed`; how many actions were recorded.
 * One chain's Hyperion failing leaves the others read, and is reported after them.
 */
export async function followSwaps(cfg: IndexerConfig, store: Store): Promise<number> {
  let recorded = 0;
  const failures: string[] = [];
  for (const c of swapChains(cfg)) {
    try {
      recorded += await followChain(store, c);
    } catch (err) {
      failures.push(`${c.chain}: ${(err as Error).message}`);
    }
  }
  if (failures.length) throw new Error(failures.join('; '));
  return recorded;
}

async function followChain(store: Store, c: SwapChain): Promise<number> {
  const key = `swaps:${c.chain}`;
  const now = Math.floor(Date.now() / 1000);
  const cursor = store.getNumber(key) ?? now - FIRST_LOOK_SECONDS;
  // A row a stale-ABI host wrote (before hosts were checked) is read again from its own time.
  const broken = store.oldestMalformedSwap(c.chain);
  const after = Math.min(cursor - OVERLAP_SECONDS, broken === undefined ? Infinity : broken - OVERLAP_SECONDS);
  const [opened, closed] = await Promise.all([
    hyperionActions(c.history, c.account, 'opened', after, wellFormedOpened),
    hyperionActions(c.history, c.account, 'closed', after, wellFormedClosed),
  ]);
  const recorded = applySwapActions(store, c.chain, opened, closed);
  const newest = Math.max(cursor, now - QUIET_LOOK_SECONDS, ...[...opened, ...closed].map((a) => seconds(a.timestamp)));
  store.setMeta(key, String(newest));
  return recorded;
}

/**
 * How a swap on the way stands, as a UI shows it.
 *
 *   swapping   the order waits for its swap
 *   swapped    the token asked for, delivered to `to`
 *   unread     the memo asked for nothing the contract could do; delivered to `back` as it arrived
 *   late       it arrived past its deadline; delivered to `back` as it arrived
 *   expired    no route paid the least by the deadline; delivered to `back` as it arrived
 *   cancelled  the account `back` names took it as it arrived
 */
export type SwapStatus = 'swapping' | 'swapped' | 'unread' | 'late' | 'expired' | 'cancelled';

export type SwapView = {
  chain: string;
  id: number;
  status: SwapStatus;
  /** Where the token bought goes: an account on `chain`, or `<domain>:<recipient>` on another chain. */
  to: string;
  /** Where the token that arrived goes if it is never swapped, spelled the same way. */
  back: string;
  input: string;
  least: string | null;
  deadline: number | null;
  /** What was delivered where, once the order ended. */
  paid: SwapPayment[];
  /**
   * The withdrawals that carry a delivery on to another chain, by transfer key
   * (`w:<id>`): follow those for the rest of the journey. Empty for a delivery
   * on `chain` itself, and until the indexer has read the withdrawal.
   */
  onward: string[];
  /** One line for a person: `delivered as 4033.1234 TLM`, `refunded as 50.000000 USDC`. */
  summary: string;
  payoutTx: string;
  closedTx: string | null;
};

const WHY: Record<string, string> = {
  unread: 'the memo was not understood',
  late: 'it arrived past its deadline',
  expired: 'no route paid the least by the deadline',
  cancelled: 'cancelled by the account it goes back to',
};

/** `4033.1234 TLM` out of `4033.1234 TLM@alien.worlds`. */
const shown = (asset: string): string => asset.split('@')[0];

/** What an ended order delivered where; empty while it is open. */
const paid = (row: SwapRow): SwapPayment[] => (row.paid ? (JSON.parse(row.paid) as SwapPayment[]) : []);

/** A place on another chain, `<domain>:<recipient>`, rather than an account: account names have no colon. */
const isLeg = (place: string): boolean => place.includes(':');

export function swapView(row: SwapRow, onward: string[] = []): SwapView {
  const delivered = paid(row);
  const status = (row.outcome ?? 'swapping') as SwapStatus;
  const assets = delivered.map((p) => shown(p.asset)).join(' + ');
  const summary =
    status === 'swapping' ? `swapping into at least ${shown(row.least ?? '')}`
    : status === 'swapped' ? `delivered as ${assets}`
    : `refunded as ${assets}: ${WHY[status] ?? status}`;
  return {
    chain: row.chain,
    id: row.id,
    status,
    to: row.recipient,
    back: row.back,
    input: row.input,
    least: row.least,
    deadline: row.deadline,
    paid: delivered,
    onward,
    summary,
    payoutTx: row.payout_tx,
    closedTx: row.closed_tx,
  };
}

/** The swap a payout made, if it made one. */
export const swapOfPayout = (store: Store, tx: string | null | undefined): SwapView | null => {
  const row = tx ? store.swapByPayout(tx) : undefined;
  if (!row) return null;
  const onward = row.closed_tx && paid(row).some((p) => isLeg(p.to)) ? store.withdrawalsOpenedIn(row.closed_tx) : [];
  return swapView(row, onward);
};
