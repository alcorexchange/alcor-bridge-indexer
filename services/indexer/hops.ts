/**
 * Hops through `bridgehop`: two source chains meeting on Telos.
 *
 * Every route runs between Telos and one other chain, so Ethereum to WAX is two
 * crossings: a deposit that names the hop contract, and the withdrawal it opens
 * in the same transaction. On the ledger they are two rows, `d:<domain>:<nonce>`
 * and `w:<id>`; to the person sending, they are one transfer. This is where
 * they become one again — a journey, keyed by the deposit it started with — and
 * where the pairs of chains a hop connects are listed.
 *
 * A journey has more legs only when something went wrong: a hop voided on the
 * far side comes back to the contract, and `recover` sends it to the way back
 * as a hop of its own, whose `prev` names the one it returns.
 */

import { withdrawalKey, type HopRow, type Store, type TransferRow } from './db.ts';
import { transferProgress, type Progress, type ProgressContext } from './progress.ts';
import { swapOfPayout } from './swaps.ts';

/** One end of a leg, with the chain's registry id where this build knows the domain. */
export type Place = { domain: string; recipient: string; chain: string | null };

/** What a transfer row says about the hop it is part of. */
export type HopLink = {
  /** The deposit the journey started with: `GET /v1/hops/<journey>`. Null when the stream never named it. */
  journey: string | null;
  /** On a deposit: the withdrawal that carried it on. */
  next?: string;
  /** On a withdrawal: the deposit it carries on, or the hop it sends back. */
  from?: string | null;
  to: Place;
  back: Place;
};

/**
 * Where a journey stands, for a person:
 *
 *   arriving   the deposit is on its way to Telos, or parked for `forward`
 *   bounced    the hop refused it — no memo, a bad one, a closed route — and
 *              the deposit went back to where it came from
 *   sending    carried on; the withdrawal is on its way over there
 *   delivered  paid out over there — done
 *   returning  voided over there; on its way back to the way back
 *   returned   paid out at the way back — done, the other way
 */
export type JourneyStatus = 'arriving' | 'bounced' | 'sending' | 'delivered' | 'returning' | 'returned';

type ChainOf = (domain: string | null) => string | null;

const place = (domain: string, recipient: string, chainOf: ChainOf): Place => ({
  domain,
  recipient,
  chain: chainOf(domain),
});

/**
 * The hop memo, `<domain>:<recipient>[:<fee>]|<domain>:<recipient>[|<memo>]`,
 * read for display only — the contract is what decides whether it is valid.
 * The fee is the courier's for the leg out and the transfer row of that leg
 * carries it; the third part is the far side's memo. Neither says where the hop
 * goes. Undefined when it is not that shape.
 */
export function parseHopMemo(memo: string | null): { to: [string, string]; back: [string, string] } | undefined {
  const legs = memo?.split('|');
  if (!legs || legs.length < 2) return undefined;
  const [to, back] = legs.slice(0, 2).map((l) => l.split(':'));
  if ((to.length !== 2 && to.length !== 3) || back.length !== 2) return undefined;
  return { to: [to[0], to[1]], back: [back[0], back[1]] };
}

/** The deposit that started the journey `hop` belongs to; null when the stream never named it. */
export const journeyOf = (store: Store, hop: HopRow): string | null => firstOf(store, hop).deposit;

/** The first hop of the journey `hop` belongs to, walking `prev` back. */
function firstOf(store: Store, hop: HopRow): HopRow {
  let h = hop;
  // Bounded: every step back is a withdrawal TTL, so a journey this long does not happen.
  for (let i = 0; h.prev !== null && i < 1000; i++) {
    const before = store.getHop(h.prev);
    if (!before) break;
    h = before;
  }
  return h;
}

/** The `hop` field of a transfer row, or null when the row is no part of a hop. */
export function hopLink(store: Store, row: TransferRow, chainOf: ChainOf): HopLink | null {
  if (row.direction === 'deposit') {
    const h = store.hopOfDeposit(row.key);
    if (!h) return null;
    return {
      journey: row.key,
      next: withdrawalKey(h.id),
      to: place(h.to_domain, h.to_recipient, chainOf),
      back: place(h.back_domain, h.back_recipient, chainOf),
    };
  }
  const h = store.getHop(row.ref);
  if (!h) return null;
  return {
    journey: firstOf(store, h).deposit,
    from: h.prev !== null ? withdrawalKey(h.prev) : h.deposit,
    to: place(h.to_domain, h.to_recipient, chainOf),
    back: place(h.back_domain, h.back_recipient, chainOf),
  };
}

/**
 * A journey, from the deposit that started it: both legs, where it stands, and
 * the one action anyone may push to move it on when it is stuck.
 */
export function journey<T>(
  store: Store,
  key: string,
  decorate: (row: TransferRow) => T,
  chainOf: ChainOf,
  hopAccount: string | undefined,
  progressCtx: ProgressContext,
) {
  const deposit = store.getTransfer(key);
  if (!deposit || deposit.direction !== 'deposit') return undefined;

  const hops: HopRow[] = [];
  for (let h = store.hopOfDeposit(key); h && hops.length < 1000; h = store.hopAfter(h.id)) hops.push(h);
  const legs = hops.map((h) => ({ hop: h, transfer: store.getTransfer(withdrawalKey(h.id)) }));
  const last = legs.at(-1);
  const lastStatus = last?.transfer?.status ?? 'burned';

  let status: JourneyStatus;
  if (!last) status = deposit.status === 'bounced' ? 'bounced' : 'arriving';
  else if (lastStatus === 'released') status = legs.length === 1 ? 'delivered' : 'returned';
  else if (legs.length === 1 && lastStatus !== 'expired' && lastStatus !== 'refunded') status = 'sending';
  else status = 'returning';

  // Before the hop exists its ends are only in the memo the deposit carried.
  const memo = parseHopMemo(deposit.memo);
  const first = hops[0];
  const to = first
    ? place(first.to_domain, first.to_recipient, chainOf)
    : memo ? place(memo.to[0], memo.to[1], chainOf) : null;
  const back = first
    ? place(first.back_domain, first.back_recipient, chainOf)
    : memo ? place(memo.back[0], memo.back[1], chainOf) : null;

  // A voided leg sits in the hop contract's claim until somebody recovers it.
  // The relayer does; the action is here so that anyone else can too.
  const recover = last && lastStatus === 'refunded' && hopAccount
    ? { account: hopAccount, name: 'recover', data: { id: String(last.hop.id) } }
    : null;

  return {
    key,
    status,
    progress: journeyProgress(status, deposit, legs, to, back, progressCtx),
    from: { domain: deposit.domain, address: deposit.evm_address, chain: chainOf(deposit.domain) },
    to,
    back,
    deposit: decorate(deposit),
    /** The swap the onward leg's payout made over there, when it was paid to bridgeroute. */
    swap: legs.length ? swapOfPayout(store, legs[0].transfer?.dst_tx) : null,
    legs: legs.map(({ hop, transfer }) => ({
      key: withdrawalKey(hop.id),
      /** A way back: the hop before it was voided over there. */
      returning: hop.prev !== null,
      quantity: hop.quantity,
      to: place(hop.to_domain, hop.to_recipient, chainOf),
      tx: hop.tx,
      at: hop.at,
      transfer: transfer ? decorate(transfer) : null,
    })),
    recover,
  };
}

/**
 * The whole journey's progress: the deposit is the first half, the leg that
 * carries it on the second. ETA is to the end of what the bridge does by
 * itself — through the onward leg when a relayer pays it (an Antelope chain), up to the
 * user's release when they do (Ethereum).
 */
function journeyProgress(
  status: JourneyStatus,
  deposit: TransferRow,
  legs: { hop: HopRow; transfer: TransferRow | undefined }[],
  to: Place | null,
  back: Place | null,
  ctx: ProgressContext,
): Progress {
  const finished = (stage: string): Progress => ({ stage, percent: 100, etaSeconds: null, exact: true, waitingOn: null });
  const legProgress = (l: (typeof legs)[number]): Progress =>
    transferProgress(l.transfer ?? ({ ...deposit, direction: 'withdrawal', status: 'burned', domain: l.hop.to_domain, src_time: l.hop.at } as TransferRow), ctx);

  switch (status) {
    case 'delivered': return finished(`delivered on ${ctx.chainName(to?.domain ?? null)}`);
    case 'returned': return finished(`returned to ${ctx.chainName(back?.domain ?? null)}`);
    case 'bounced': return finished(`refused by the hop and sent back to ${ctx.chainName(deposit.domain)}`);
    case 'arriving': {
      const p = transferProgress(deposit, ctx);
      const onward = to && ctx.isAntelope(to.domain) ? ctx.withdrawalEta(to.domain)?.seconds ?? 0 : 0;
      return { ...p, percent: Math.round(p.percent / 2), etaSeconds: p.etaSeconds === null ? null : p.etaSeconds + onward };
    }
    case 'sending': {
      const p = legProgress(legs[0]);
      return { ...p, percent: 50 + Math.round(p.percent / 2) };
    }
    case 'returning': {
      const last = legs[legs.length - 1];
      if (last.transfer?.status === 'refunded') {
        return last.hop.prev === null
          ? { stage: 'not paid out over there; sending it back', percent: 0, etaSeconds: 60, exact: false, waitingOn: 'bridge' }
          : { stage: 'the way back was not paid out either; waiting for an operator', percent: 0, etaSeconds: null, exact: true, waitingOn: 'bridge' };
      }
      const p = legProgress(last);
      return { ...p, stage: `returning: ${p.stage}` };
    }
  }
}

// --- which chains a hop connects -------------------------------------------------

/** A route of one chain as `/v1/chains` lists it, the fields read here. */
type ChainRoute = {
  kind?: 'backing' | 'spoke';
  symbol: string;
  precision: number;
  deposits: boolean;
  withdrawals: boolean;
  minDeposit: string;
  minWithdrawal: string;
  maxWithdrawal: string;
  available?: string | null;
  outflowLeft?: string | null;
  withdrawableNow: string;
  depositableNow?: string | null;
  /** False while the vault lists the token but refuses deposits of it. */
  vaultEnabled?: boolean;
  withdrawMemo: string;
  depositMemo?: string;
  token?: string | null;
  antelopeToken?: { contract: string; symbol: string; precision: number };
  /** On Sui: the coin type to deposit. */
  coinType?: string;
  /** On NEAR: the NEP-141 contract to `ft_transfer_call`, or NEAR for `deposit_near`. */
  nearToken?: string;
};

type ChainEntry = {
  id: string;
  name: string;
  kind?: string;
  chainId?: number | string;
  domain?: string;
  active?: { deposits: boolean; withdrawals: boolean; reason?: string };
  routes?: ChainRoute[];
};

/** The larger of two amounts in canonical units. */
const atLeast = (a: string, b: string): string => (BigInt(a) >= BigInt(b) ? a : b);

/** The smaller of two bounds, where null is no bound at all. */
const atMost = (a: string | null | undefined, b: string | null | undefined): string | null => {
  if (a === null || a === undefined) return b ?? null;
  if (b === null || b === undefined) return a;
  return BigInt(a) <= BigInt(b) ? a : b;
};

/**
 * Why chain `c` takes no deposits of `r` now (or pays no withdrawals): the
 * route's own flag, or the chain's reason — a paused vault, a light client
 * not bootstrapped, a blockroot keeper still catching up after a restart. Null
 * while that side is open.
 */
function shut(c: ChainEntry, r: ChainRoute, side: 'deposits' | 'withdrawals'): string | null {
  const what = side === 'deposits' ? `takes no ${r.symbol} deposits now` : `pays no ${r.symbol} withdrawals now`;
  if (!r[side]) return `${c.name} ${what}`;
  if (!c.active?.[side]) return c.active?.reason ? `${c.name} ${what}: ${c.active.reason}` : `${c.name} ${what}`;
  return null;
}

/**
 * Why nothing can be paid out on chain `c` now, naming the bound at zero:
 * a vault with nothing behind the supply, a spoke at its cap, a spent daily
 * limit. Null while something can still go.
 */
function payoutEmpty(c: ChainEntry, r: ChainRoute): string | null {
  if (r.withdrawableNow !== '0') return null;
  if (r.available === '0') {
    return r.kind === 'spoke'
      ? `the ${r.symbol} mirror on ${c.name} is at its cap`
      : `the ${c.name} vault has no ${r.symbol} to pay out yet`;
  }
  if (r.outflowLeft === '0') return `the ${c.name} vault's daily ${r.symbol} limit is used up`;
  return `nothing more ${r.symbol} can be paid out on ${c.name} right now`;
}

/** Why chain `c` takes no more of the asset in now. Null while it does. */
function depositFull(c: ChainEntry, r: ChainRoute): string | null {
  // Listed but not enabled: a deposit would revert in the vault, at the
  // depositor's gas. A new route sits here until its dust round trip.
  if (r.vaultEnabled === false) return `the ${c.name} vault does not take ${r.symbol} yet`;
  if (r.depositableNow !== '0') return null;
  return r.kind === 'spoke'
    ? `no ${r.symbol} mirror is out on ${c.name} to bring back`
    : `${c.name} takes no more ${r.symbol}: its cap is reached`;
}

/**
 * Whether a route can carry anything now, and why not. A route that is open
 * with nothing left under its bound is closed to a person, whatever its flags
 * say; the reasons above name that bound, and this one is the backstop.
 */
function openness(reasons: (string | null)[], max: string | null) {
  const why = reasons.filter((x): x is string => x !== null);
  if (max === '0' && !why.length) why.push('nothing more can cross right now');
  return why.length ? { open: false, reason: why.join('; ') } : { open: true };
}

const isAntelope = (c: ChainEntry) => c.kind === 'antelope';
const isSui = (c: ChainEntry) => c.kind === 'sui';
const isNear = (c: ChainEntry) => c.kind === 'near';
const domainOf = (c: ChainEntry) => String(c.domain ?? c.chainId);
/** A recipient on `c` as a hop memo spells it: a NEAR account is the sha256 of its id. */
const recipientHint = (c: ChainEntry) =>
  isAntelope(c) ? '<account>' : isNear(c) ? '0x<sha256 of the NEAR account id>' : '0x<address>';
/** The depositor's own address on `c`, as the way back of a hop memo spells it. */
const homeHint = (c: ChainEntry) =>
  isAntelope(c) ? '<your account>' : isNear(c) ? '0x<sha256 of your NEAR account id>' : '<your address>';

/** How to deposit `r` on chain `a` (not Antelope) for `telosTo`, with `memo` if any. */
function depositHow(a: ChainEntry, r: ChainRoute, telosTo: string | null, memo?: string) {
  const token = isSui(a) ? { coinType: r.coinType ?? null } : isNear(a) ? { nearToken: r.nearToken ?? null } : { token: r.token ?? null };
  return { deposit: { ...token, telosTo, ...(memo === undefined ? {} : { memo }) } };
}

/**
 * Every way an asset can go, as pairs of chains: straight to and from Telos,
 * and between two source chains through the hop contract.
 *
 * A hop is open when the first chain takes deposits, the second pays
 * withdrawals, and something is left under both. Its bounds are what the
 * contract checks: the floors of both routes it touches — the one it goes on by
 * and the one it would come back by — and the ceiling of the first only, with
 * what the first chain may still take in. The way back's ceiling is not one: a
 * voided hop waits for `recover` until it fits. `min` the largest floor, `max`
 * the smallest ceiling, null when nothing bounds it.
 */
export function routesBetween(
  chains: ChainEntry[],
  settlement: { id: string; name: string },
  hop: { account: string | undefined; deployed: boolean },
) {
  const out: unknown[] = [];
  for (const a of chains) {
    for (const r of a.routes ?? []) {
      const depositMax = r.depositableNow ?? null;
      out.push({
        symbol: r.symbol,
        precision: r.precision,
        from: a.id,
        to: settlement.id,
        via: null,
        ...openness([shut(a, r, 'deposits'), depositFull(a, r)], depositMax),
        min: r.minDeposit,
        max: depositMax,
        how: isAntelope(a)
          ? { transfer: { contract: r.antelopeToken?.contract ?? null, memo: r.depositMemo ?? '<telos account>' } }
          : depositHow(a, r, '<telos account>'),
      });
      out.push({
        symbol: r.symbol,
        precision: r.precision,
        from: settlement.id,
        to: a.id,
        via: null,
        ...openness([shut(a, r, 'withdrawals'), payoutEmpty(a, r)], r.withdrawableNow),
        min: r.minWithdrawal,
        max: r.withdrawableNow,
        how: { transfer: { memo: r.withdrawMemo } },
      });

      for (const b of chains) {
        if (b === a) continue;
        const onward = b.routes?.find((x) => x.symbol === r.symbol);
        if (!onward) continue;
        const reasons: (string | null)[] = [];
        if (!hop.account) reasons.push('no hop contract on this ledger');
        else if (!hop.deployed) reasons.push(`${hop.account} runs no code`);
        reasons.push(shut(a, r, 'deposits'), shut(b, onward, 'withdrawals'), depositFull(a, r), payoutEmpty(b, onward));

        const memo = `${domainOf(b)}:${recipientHint(b)}|${domainOf(a)}:${homeHint(a)}`;
        const max = atMost(onward.withdrawableNow, r.depositableNow);
        out.push({
          symbol: r.symbol,
          precision: r.precision,
          from: a.id,
          to: b.id,
          via: settlement.id,
          ...openness(reasons, max),
          min: atLeast(atLeast(r.minDeposit, onward.minWithdrawal), r.minWithdrawal),
          max,
          how: isAntelope(a)
            ? { transfer: { contract: r.antelopeToken?.contract ?? null, memo: `${hop.account}:${memo}` } }
            : depositHow(a, r, hop.account ?? null, memo),
        });
      }
    }
  }
  return out;
}
