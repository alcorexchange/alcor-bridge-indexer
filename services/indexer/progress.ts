/**
 * How far a crossing has got, as a person wants to see it: what is happening,
 * a percentage, and how long until the bridge's own part is done.
 *
 * Counted where the chain gives something to count — an Ethereum deposit on the
 * fast path is so many confirmations of the route's `min_confirmations` — and
 * estimated from the measured timings (`src/chains/eta.ts`) where it does not:
 * WAX producers confirming a block, Ethereum finalizing one. `exact` says which.
 *
 * `etaSeconds` covers only what the bridge does by itself. A step that waits on
 * a person — releasing a withdrawal on Ethereum, which the user pays for — has
 * `waitingOn: 'user'` and no ETA: the bridge cannot know when they will.
 */

import type { Eta } from '../../src/chains/eta.ts';
import { fastVerdict, type RouteLimits } from './fast.ts';
import type { TransferRow } from './db.ts';

export type Progress = {
  /** What is happening now, in words. */
  stage: string;
  /** 0–100. */
  percent: number;
  /** Seconds until the bridge's own part is done; null when finished or waiting on a person. */
  etaSeconds: number | null;
  /** Counted from the chain (true) or estimated from measured timings (false). */
  exact: boolean;
  /** Who the next step waits on; null when there is no next step. */
  waitingOn: 'bridge' | 'user' | null;
};

/** What a row's progress is read against. */
export type ProgressContext = {
  now: number;
  /** The newest block the follower has seen on an EVM domain; undefined where none follows it. */
  evmHead: (domain: string) => number | undefined;
  route: (token: string | null, domain: string | null) => RouteLimits | undefined;
  chainName: (domain: string | null) => string;
  isAntelope: (domain: string | null) => boolean;
  depositEta: (domain: string) => Eta | null;
  withdrawalEta: (domain: string) => Eta | null;
};

/** An Ethereum block, and what a push to Telos takes once a proof exists. */
const BLOCK_SECONDS = 12;
const PUSH_SECONDS = 5;

const done = (stage: string): Progress => ({ stage, percent: 100, etaSeconds: null, exact: true, waitingOn: null });

/**
 * A step estimated from the time it usually takes: how much of it has passed,
 * held under `cap` so an estimate never claims to be finished, and a few
 * seconds left rather than none once it runs over.
 */
function byTime(stage: string, since: number, eta: Eta, now: number, cap = 95): Progress {
  const elapsed = Math.max(0, now - since);
  return {
    stage,
    percent: Math.min(cap, Math.round((elapsed / eta.seconds) * cap)),
    etaSeconds: Math.max(PUSH_SECONDS, eta.seconds - elapsed),
    exact: false,
    waitingOn: 'bridge',
  };
}

export function transferProgress(row: TransferRow, ctx: ProgressContext): Progress {
  const chain = ctx.chainName(row.domain);
  return row.direction === 'deposit' ? depositProgress(row, chain, ctx) : withdrawalProgress(row, chain, ctx);
}

function depositProgress(row: TransferRow, chain: string, ctx: ProgressContext): Progress {
  switch (row.status) {
    case 'credited': return done('credited on Telos');
    case 'forwarded': return done('delivered on Telos');
    case 'bounced': return done(`refused on Telos and sent back to ${chain}`);
    case 'parked':
      return { stage: 'credited; handing it on', percent: 97, etaSeconds: PUSH_SECONDS, exact: false, waitingOn: 'bridge' };
  }

  // Seen on its chain, not proved yet. Counted the way the ledger counts it
  // (`fastVerdict`), so this never reads "12 of 12" while the queue says 11.
  const domain = row.domain ?? '';
  const head = ctx.evmHead(domain);
  if (!ctx.isAntelope(row.domain) && head !== undefined && row.src_block > 0) {
    const fast = fastVerdict(ctx.route(row.token, row.domain), BigInt(row.amount ?? 0), head - row.src_block);
    if (fast.offered && fast.left > 0) {
      return {
        stage: `${fast.confirmations} of ${fast.required} confirmations on ${chain}`,
        percent: Math.round((fast.confirmations / fast.required) * 90),
        etaSeconds: fast.left * BLOCK_SECONDS + PUSH_SECONDS,
        exact: true,
        waitingOn: 'bridge',
      };
    }
    if (fast.offered) {
      return { stage: 'confirmed; proving it on Telos', percent: 95, etaSeconds: PUSH_SECONDS, exact: true, waitingOn: 'bridge' };
    }
  }

  const eta = ctx.depositEta(domain);
  const stage = ctx.isAntelope(row.domain) ? `${chain} producers confirming` : `waiting for ${chain} to finalize`;
  return eta
    ? byTime(stage, row.src_time, eta, ctx.now)
    : { stage, percent: 0, etaSeconds: null, exact: false, waitingOn: 'bridge' };
}

function withdrawalProgress(row: TransferRow, chain: string, ctx: ProgressContext): Progress {
  switch (row.status) {
    case 'released': return done(`paid out on ${chain}`);
    case 'refunded': return done('expired unpaid; refunded on Telos');
    case 'expired':
      return { stage: `expired unpaid on ${chain}; refunding on Telos`, percent: 90, etaSeconds: null, exact: false, waitingOn: 'bridge' };
  }

  // A relayer pays an Antelope chain; on an EVM chain the recipient releases it.
  const domain = row.domain ?? '';
  if (ctx.isAntelope(row.domain)) {
    const eta = ctx.withdrawalEta(domain);
    const stage = `${chain} release by the relayer`;
    return eta
      ? byTime(stage, row.src_time, eta, ctx.now)
      : { stage, percent: 0, etaSeconds: null, exact: false, waitingOn: 'bridge' };
  }
  if (row.status === 'provable') {
    return { stage: `ready: release it on ${chain}`, percent: 50, etaSeconds: null, exact: true, waitingOn: 'user' };
  }
  return { stage: 'burned on Telos; freezing its proof', percent: 25, etaSeconds: PUSH_SECONDS, exact: false, waitingOn: 'bridge' };
}
