/**
 * A crossing that is waiting on something other than time.
 *
 * Progress estimates a step from how long it usually takes, which is right
 * while the step is running and wrong once something stops it: a deposit the
 * bridge parked and will not hand on read "credited; handing it on, 5 s" for
 * as long as it sat there. These are the stops the indexer can see:
 *
 *   held          a parked deposit still parked after `HELD_AFTER_SECONDS`.
 *                 `forward` refused it — a closed route, a leg over its
 *                 limit, a blocked depositor — and someone has to look.
 *   over-limit    a deposit the ledger will refuse to credit: on a backing
 *                 route with a cap, `backing + amount` is over it.
 *   daily-limit   a withdrawal to an EVM chain larger than what the vault will
 *                 still let out today. It waits for the limit to refill.
 *
 * The words are neutral on purpose. A deposit held because its sender is
 * blocked reads the same as any other held deposit: the page is public, and
 * the sender reads it too.
 */
import type { TransferRow } from './db.ts';
import { SETTLED } from './db.ts';

export type HoldFlag = 'held' | 'over-limit' | 'daily-limit';

export type Hold = {
  flag: HoldFlag;
  /** What is happening, in words, for the page. */
  stage: string;
  /** Unix seconds the wait should end, when it can be told; null otherwise. */
  until: number | null;
};

/** What a ledger route allows right now, in canonical units. */
export type RouteRoom = {
  /** Zero means uncapped. */
  cap: bigint;
  backing: bigint;
  maxWithdrawal: bigint;
  /** A spoke's deposit unlocks what was locked; the cap does not bound it. */
  spoke: boolean;
};

/** A vault's daily outflow for one token, canonical units. */
export type Outflow = { left: bigint; perDay: bigint };

export type HoldContext = {
  now: number;
  route: (token: string | null, domain: string | null) => RouteRoom | undefined;
  /** Null for a token with no daily limit; undefined when it was not read. */
  outflow: (token: string | null, domain: string | null) => Outflow | null | undefined;
  chainName: (domain: string | null) => string;
};

/** A parked deposit is normally forwarded in the same minute. */
export const HELD_AFTER_SECONDS = 600;

const DAY = 86_400;

export function holdOf(row: TransferRow, ctx: HoldContext): Hold | null {
  return row.direction === 'deposit' ? depositHold(row, ctx) : withdrawalHold(row, ctx);
}

function depositHold(row: TransferRow, ctx: HoldContext): Hold | null {
  if (row.status === 'parked') {
    const since = row.dst_time ?? row.src_time;
    if (ctx.now - since < HELD_AFTER_SECONDS) return null;
    return { flag: 'held', stage: 'held on Telos for review; the funds are safe', until: null };
  }
  if (row.status !== 'seen' && row.status !== 'provable') return null;

  const route = ctx.route(row.token, row.domain);
  if (!route || route.spoke || route.cap === 0n || row.amount === null) return null;
  if (route.backing + BigInt(row.amount) <= route.cap) return null;
  return {
    flag: 'over-limit',
    stage: 'above the route\'s current limit; held for review, the funds are safe',
    until: null,
  };
}

function withdrawalHold(row: TransferRow, ctx: HoldContext): Hold | null {
  if (SETTLED.includes(row.status) || row.status === 'expired' || row.amount === null) return null;
  const outflow = ctx.outflow(row.token, row.domain);
  if (!outflow) return null;

  const amount = BigInt(row.amount);
  if (amount <= outflow.left) return null;
  const chain = ctx.chainName(row.domain);
  // A limit of zero lets nothing out and never refills: an operator's stop, not a wait.
  if (outflow.perDay === 0n) {
    return { flag: 'daily-limit', stage: `waiting: ${chain} is not paying this token out right now`, until: null };
  }
  return {
    flag: 'daily-limit',
    stage: `waiting for the daily withdrawal limit on ${chain} to refill`,
    until: ctx.now + Number(((amount - outflow.left) * BigInt(DAY) + outflow.perDay - 1n) / outflow.perDay),
  };
}

/**
 * A withdrawal large enough that an operator wants to know of it: at least
 * `share` of its route's `maxWithdrawal`. Not a hold — nothing stops it —
 * so it is read by `/health`, never shown on the crossing itself.
 */
export function isLarge(row: TransferRow, route: RouteRoom | undefined, share = 0.5): boolean {
  if (row.direction !== 'withdrawal' || !route || route.maxWithdrawal === 0n || row.amount === null) return false;
  return BigInt(row.amount) * 100n >= route.maxWithdrawal * BigInt(Math.round(share * 100));
}
