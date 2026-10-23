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
 * The contract erases an order when it ends, so both actions are read out of
 * each chain's state-history stream as they happen (actions.ts) and applied
 * here.
 *
 * An action is stored only in the shape the contract declares.
 */

import { ANTELOPE_SWAPS } from '../../src/chains/swaps.ts';
import type { ChainAction, Store, SwapPayment, SwapRow } from './db.ts';

/** bridgeroute's account on `chain`, if it is deployed there. */
export const routeOf = (chain: string): string | undefined => ANTELOPE_SWAPS[chain]?.route;

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
 * Record `chain`'s bridgeroute `opened` and `closed` actions; opened first, so a
 * payout's own transaction wins. Returns how many changed a row: a block read
 * twice brings the same actions back.
 */
export function applySwapActions(store: Store, chain: string, actions: ChainAction[]): number {
  let fresh = 0;
  for (const a of actions.filter((x) => x.name === 'opened')) {
    const d = a.data;
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
      opened_at: a.time,
    };
    if (store.swapOf(chain, row.id)?.payout_tx === row.payout_tx) continue;
    fresh++;
    store.putSwapOpened(row);
  }
  for (const a of actions.filter((x) => x.name === 'closed')) {
    const d = a.data;
    if (!wellFormedClosed(d)) continue;
    if (store.swapOf(chain, Number(d.id))?.outcome) continue;
    fresh++;
    store.putSwapClosed({
      chain,
      id: Number(d.id),
      outcome: d.outcome,
      paid: (d.paid as { to: string; tokens: ExtendedAsset }[]).map((p) => ({ to: p.to, asset: written(p.tokens) })),
      tx: a.trx_id,
      at: a.time,
    });
  }
  return fresh;
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
