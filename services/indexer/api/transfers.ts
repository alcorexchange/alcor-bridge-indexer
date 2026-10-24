/**
 * Transfers as a UI wants them: one row decorated with what the chain row cannot
 * say (flags, the asset, progress, the hop and swap it belongs to), the list, and
 * an account's page.
 */

import { humanAmount, parseAsset } from '../../../src/units.ts';
import { getTableRows } from '../../../src/net/antelope.ts';
import { antelopeToken } from '../chains.ts';
import { chainOfDomain } from '../config.ts';
import { stateOf, type ActivityState } from '../activity.ts';
import { SETTLED, type TransferRow } from '../db.ts';
import { assetFor } from '../fast.ts';
import { holdOf } from '../holds.ts';
import { hopLink, type HopLink } from '../hops.ts';
import { transferProgress, type Progress } from '../progress.ts';
import { swapOfPayout, type SwapView } from '../swaps.ts';
import { holdContext, progressContext } from './context.ts';
import { chainOf, inWindow, rootCovering, type Deps } from './deps.ts';
import { exact, fail, intParam, json, pattern, type Route } from './http.ts';

/**
 * How long a proved crossing may wait on the bridge's own pusher before a UI
 * should say so and offer it to anyone: the closer for a deposit, the courier
 * for a withdrawal burned with a delivery fee.
 */
const STUCK_SECONDS = 30 * 60;

export const transferRoutes: Route[] = [
  {
    shown: '/v1/transfers',
    match: exact('/v1/transfers'),
    handle: ({ deps, q }) => {
      const rows = deps.store.listTransfers({
        account: q.get('account') ?? undefined,
        address: q.get('address') ?? undefined,
        direction: (q.get('direction') as any) ?? undefined,
        status: q.get('status') ?? undefined,
        before: intParam(q, 'before', 0, Number.MAX_SAFE_INTEGER),
        limit: intParam(q, 'limit', 1, 500),
      });
      const decorated = rows.map((r) => decorate(deps, r));
      const filtered = q.get('flag')
        ? decorated.filter((r) => r.flags.includes(q.get('flag')!))
        : decorated;
      return json(200, { transfers: filtered, count: filtered.length });
    },
  },
  {
    shown: '/v1/transfers/<key>',
    match: pattern(/^\/v1\/transfers\/(.+)$/),
    handle: ({ deps, params: [key] }) => {
      const row = deps.store.getTransfer(key);
      if (!row) return fail(404, 'NOT_FOUND', 'no such transfer');
      return json(200, decorate(deps, row));
    },
  },
  {
    shown: '/v1/accounts/<account>/transfers',
    match: pattern(/^\/v1\/accounts\/([^/]+)\/transfers$/),
    handle: ({ deps, q, params: [account] }) => {
      const rows = deps.store.listTransfers({
        account,
        limit: intParam(q, 'limit', 1, 500),
        before: intParam(q, 'before', 0, Number.MAX_SAFE_INTEGER),
      });
      return json(200, { account, transfers: rows.map((r) => decorate(deps, r)) });
    },
  },
  {
    shown: '/v1/accounts/<account>',
    match: pattern(/^\/v1\/accounts\/([^/]+)$/),
    handle: async ({ deps, params: [name] }) => json(200, await account(deps, name)),
  },
];

async function account(deps: Deps, name: string) {
  const rows = deps.store.listTransfers({ account: name, limit: 500 });
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.status] = (counts[r.status] ?? 0) + 1;
  const decorated = rows.map((r) => decorate(deps, r));

  // A credit issues to the bridge and records what the beneficiary may collect;
  // collecting is a separate act. Saying "credited" without saying whether it
  // was picked up tells half of it, and the half a user acts on is this one.
  let claimable: { symbol: string; amount: string; precision: number | null }[] = [];
  try {
    const rowsOut = await getTableRows<{ balance: string }>(deps.cfg.savanna, {
      code: deps.cfg.savanna.accounts.bridge,
      scope: name,
      table: 'claims',
    });
    claimable = rowsOut.map((r) => {
      // `"0.01000000 ETH"` -> 1000000 at precision 8, as a decimal string: the
      // front end compares strings, and `001000000` is not `1000000`.
      const { units, symbol, precision } = parseAsset(String(r.balance));
      return { symbol, amount: units.toString(), precision };
    });
  } catch {
    // The chain not answering is not a reason to fail the whole page.
  }

  return {
    account: name,
    counts,
    open: decorated.filter((r) => !SETTLED.includes(r.status)).length,
    needsAttention: decorated.filter((r) => r.flags.length).length,
    claimable,
    claims: deps.store.claimsOf(name, 10),
    transfers: decorated.slice(0, 50),
  };
}

export type DecoratedTransfer = TransferRow & {
  flags: string[];
  hasProof: boolean;
  /** Which settlement track a proof request would return, without asking for it. */
  track: 'light' | 'hard' | null;
  secondsToDeadline: number | null;
  /** What `amount` is denominated in. Without it the number means nothing. */
  precision: number | null;
  /** The far chain, by its registry id: `mainnet`, `wax`. Null for a domain this build does not know. */
  chain: string | null;
  /**
   * The token, ready to show: the symbol and its decimals, and where it lives
   * over there — an ERC-20 address, or an Antelope (contract, symbol) pair.
   */
  asset: { symbol: string; precision: number; address?: string; contract?: string } | null;
  /** `amount` with its decimals and symbol: `20 WAX`, `0.001 ETH`. Null until the token is known. */
  amountHuman: string | null;
  /** This row as one leg of a hop between two chains; null for a crossing that ends on Telos. */
  hop: HopLink | null;
  /**
   * The swap its payout made at the far end — `delivered as 4033.1234 TLM`,
   * `refunded as 50.000000 USDC` — when it was paid out to bridgeroute; null otherwise.
   */
  swap: SwapView | null;
  /** How far it has got: stage, percent, ETA, and whether the next step waits on the user. */
  progress: Progress;
  /** Where it stands, in the four words `/v1/activity` uses; `status` is the detailed lifecycle and may gain values. */
  state: ActivityState;
};

/**
 * Add what a chain row cannot say.
 *
 * `flags` is the part a UI actually renders: `stuck`, `past-deadline`,
 * `unprovable`. They are computed rather than stored because they are functions
 * of the clock, and a stored one would be stale the moment it was written.
 */
export function decorate(deps: Deps, row: TransferRow): DecoratedTransfer {
  const now = Math.floor(Date.now() / 1000);
  const hasProof = deps.store.hasProof(row.key);
  const flags: string[] = [];

  const settled = SETTLED.includes(row.status);
  const secondsToDeadline = row.deadline ? row.deadline - now : null;

  const far = chainOfDomain(deps.cfg, row.domain);
  if (row.direction === 'withdrawal' && !settled) {
    // An EVM release needs the artifact frozen here; an Antelope chain's relayer proves its own.
    if (!hasProof && far?.kind !== 'antelope') flags.push('unfrozen');
    if (secondsToDeadline !== null && secondsToDeadline <= 0) flags.push('past-deadline');
  }
  if (row.status === 'provable' && now - (row.proof_at ?? now) > STUCK_SECONDS) {
    // A withdrawal with no fee waits on its owner, not on the bridge: it is
    // never late, only not sent yet.
    const courier = row.direction === 'withdrawal' && BigInt(row.fee ?? '0') > 0n;
    if (row.direction === 'deposit' || courier) flags.push('stuck');
  }
  if (row.status === 'expired') flags.push('rolled-back');
  const hold = holdOf(row, holdContext(deps));
  if (hold) flags.push(hold.flag);

  let track: 'light' | 'hard' | null = null;
  if (hasProof && row.direction === 'withdrawal') {
    const covering = rootCovering(deps, row, row.src_block);
    track = covering && inWindow(deps, covering.block) ? 'light' : 'hard';
  }

  // `amount` is an integer in canonical units, and the same integer is 0.01 ETH
  // on one route and 1.0 ATUSD on another. The symbol the bridge issues carries
  // the precision, so it travels with every row rather than being guessed at.
  const listed = assetFor(row.token, row.domain);
  const asset = listed
    ? {
        symbol: listed.symbol,
        precision: listed.precision,
        ...(far?.kind === 'antelope'
          ? { contract: antelopeToken(row.token ?? '')?.contract }
          : far?.kind === 'sui' || far?.kind === 'near'
            ? { token: row.token ?? undefined }
            : { address: row.token ?? undefined }),
      }
    : null;
  const chain = far?.chain.id ?? null;
  const progress = transferProgress(row, progressContext(deps));

  return {
    ...row,
    symbol: asset?.symbol ?? row.symbol,
    precision: asset?.precision ?? null,
    chain,
    asset,
    amountHuman: asset && row.amount !== null ? humanAmount(row.amount, asset.precision, asset.symbol) : null,
    flags,
    hasProof,
    track,
    secondsToDeadline,
    hop: hopLink(deps.store, row, (domain) => chainOf(deps, domain)),
    swap: swapOfPayout(deps.store, row.dst_tx),
    progress,
    state: stateOf(row, progress),
  };
}
