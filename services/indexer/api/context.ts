/**
 * What a row is read against when it is rendered: the followers' heads and the
 * measured timings for `progress`, the routes and the vaults' daily limits for
 * `holds`. A row renders synchronously, so these read what is already known.
 */

import { antelopeDepositEta, antelopeWithdrawalEta, depositEta, nearDepositEta, nearWithdrawalEta, suiDepositEta, suiWithdrawalEta, withdrawalEta } from '../../../src/chains/eta.ts';
import { chainOfDomain } from '../config.ts';
import { holdOf, type HoldContext, type Outflow } from '../holds.ts';
import type { ActivityContext } from '../activity.ts';
import { assetFor, routeLimits, routeRoom } from '../fast.ts';
import type { ProgressContext } from '../progress.ts';
import { chainOf, followerOf, type Deps } from './deps.ts';

/** What `progress` is read against: the followers' heads, the listed routes, the measured timings. */
export function progressContext(deps: Deps): ProgressContext {
  const of = (domain: string | null) => chainOfDomain(deps.cfg, domain);
  return {
    now: Math.floor(Date.now() / 1000),
    evmHead: (domain) => followerOf(deps, domain)?.state.head || undefined,
    route: routeLimits,
    chainName: (domain) => of(domain)?.chain.name ?? 'the far chain',
    // A Sui or NEAR deposit, like an Antelope one, is proved by its relayer.
    isAntelope: (domain) => ['antelope', 'sui', 'near'].includes(of(domain)?.kind ?? ''),
    depositEta: (domain) => {
      const far = of(domain);
      if (!far) return null;
      if (far.kind === 'sui') return suiDepositEta(far.chain);
      if (far.kind === 'near') return nearDepositEta(far.chain);
      return far.kind === 'antelope' ? antelopeDepositEta(far.chain) : depositEta(far.chain);
    },
    withdrawalEta: (domain) => {
      const far = of(domain);
      if (!far) return null;
      if (far.kind === 'sui') return suiWithdrawalEta(far.chain);
      if (far.kind === 'near') return nearWithdrawalEta(far.chain);
      return far.kind === 'antelope' ? antelopeWithdrawalEta(far.chain) : withdrawalEta(far.chain);
    },
    hold: (row) => holdOf(row, holdContext(deps)),
  };
}

/**
 * Each EVM vault's daily outflow per token, as the last `/v1/chains` read it:
 * keyed `<chain id>:<token>`, null for a token with no limit. A row renders
 * synchronously, so it reads what is known rather than waiting on a vault.
 */
const outflows = new Map<string, Outflow | null>();

const bareToken = (token: string) => token.replace(/^0x/, '').toLowerCase();

export function rememberOutflows(sources: { chainId?: number | string; routes?: any[] }[]): void {
  for (const source of sources) {
    if (source.chainId === undefined) continue;
    for (const r of source.routes ?? []) {
      if (r.outflowError || r.outflowLeft === undefined || !r.token) continue;
      outflows.set(
        `${source.chainId}:${bareToken(r.token)}`,
        r.outflowLeft === null ? null : { left: BigInt(r.outflowLeft), perDay: BigInt(r.outflowPerDay) },
      );
    }
  }
}

/** What `holds.ts` reads a row against: the ledger's routes and the vaults' daily limits. */
export function holdContext(deps: Deps): HoldContext {
  return {
    now: Math.floor(Date.now() / 1000),
    route: routeRoom,
    outflow: (token, domain) => (token && domain !== null ? outflows.get(`${domain}:${bareToken(token)}`) : undefined),
    chainName: (domain) => chainOfDomain(deps.cfg, domain)?.chain.name ?? 'the far chain',
  };
}

/** What a transfer is folded and read against for `/v1/activity`: the hop account, the chains, the listings, `progress`. */
export function activityContext(deps: Deps): ActivityContext {
  return {
    hop: deps.cfg.savanna.accounts.hop,
    chainOf: (domain) => chainOf(deps, domain),
    asset: assetFor,
    progress: progressContext(deps),
  };
}
