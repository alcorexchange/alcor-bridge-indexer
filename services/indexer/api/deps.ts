/**
 * What every route is handed, and the lookups on it that several routes share:
 * which chain and follower a row's domain names, and the clocks a row runs on.
 */

import { SLOT_SECONDS } from '../../../src/config.ts';
import { depositEta, nearDepositEta, suiDepositEta } from '../../../src/chains/eta.ts';
import { chainOfDomain, type IndexerConfig } from '../config.ts';
import type { Store, TransferRow } from '../db.ts';
import type { SettlementFollower } from '../savanna.ts';
import type { EvmFollower } from '../evm.ts';
import type { BlockrootKeeper } from '../blockroot.ts';
import type { ActionFollower } from '../actions.ts';
import type { EventLog } from '../events.ts';

export type Deps = {
  cfg: IndexerConfig;
  store: Store;
  savanna: SettlementFollower;
  /**
   * Every source chain's follower, this instance's own chain first.
   *
   * There used to be a second field holding just that first one, for everything
   * written while one process followed one chain. It outlived its use and became
   * a trap: `fastReady` reached for it and measured an Amoy deposit's depth
   * against the Sepolia head. A row names its domain — look the follower up.
   */
  evms: EvmFollower[];
  /** A blockroot keeper per legacy chain this instance follows, by chain id. */
  keepers: Map<string, BlockrootKeeper>;
  /** Our own history of each Antelope chain, Telos first (actions.ts). */
  histories: ActionFollower[];
  /** Each change to a transfer, numbered and kept (events.ts): what `/v1/stream` sends. */
  events: EventLog;
  startedAt: number;
};

export const inWindow = (deps: Deps, block: number): boolean => {
  const first = deps.savanna.leafStore.firstBlock;
  const last = deps.savanna.leafStore.lastBlock;
  return first !== undefined && last !== undefined && block >= first && block <= last;
};

/** The cheapest root to fold a burn into: the oldest at or after it that the withdrawal's own chain trusts. */
export function rootCovering(deps: Deps, row: TransferRow, burnBlock: number) {
  const target = chainOfDomain(deps.cfg, row.domain);
  return target?.kind === 'evm' ? deps.store.earliestRootCovering(burnBlock, target.chain.chainId) : undefined;
}

/** The far chain of a domain, by its registry id: `mainnet`, `wax`, `xpr`, `vaulta`; null for one this instance does not know. */
export const chainOf = (deps: Deps, domain: string | null): string | null => chainOfDomain(deps.cfg, domain)?.chain.id ?? null;

/**
 * The follower watching a domain's chain.
 *
 * The row carries its domain, and that is what decides. This used to reach for a
 * single "own chain" follower instead, which subtracted one chain's height from
 * another chain's block number — an Amoy deposit measured against the Sepolia
 * head. That field is gone now so the shortcut cannot come back.
 */
export function followerOf(deps: Deps, domain: string | null) {
  const source = chainOfDomain(deps.cfg, domain);
  return source?.kind === 'evm' ? deps.evms.find((f) => f.id === source.chain.id) : undefined;
}

/**
 * When a deposit's finalized proof stops fitting in one transaction; undefined
 * where there is no such clock.
 *
 * Only a beacon chain has one. Its finalized proof carries the `parent_root`
 * chain from the deposit's block up to a finalized header, one header a slot,
 * and the follower builds none longer than `maxAncestry` headers — it stops
 * queueing a deposit older than `maxAncestry * 12` seconds and refuses a longer
 * span when freezing (evm.ts, `freezeLog`). That is 13.65 hours at 4096, not the
 * sixteen this used to quote: sixteen is roughly where 600 KB runs out, and the
 * builder gives up before then. A Parlia or milestone proof is final in seconds
 * and carries no such chain; an Antelope deposit is its relayer's.
 */
export function ancestryDeadline(cfg: IndexerConfig, row: TransferRow): number | undefined {
  const source = chainOfDomain(cfg, row.domain);
  if (source?.kind !== 'evm' || source.chain.strategy !== 'beacon') return undefined;
  return row.src_time + cfg.maxAncestry * SLOT_SECONDS;
}

/**
 * How long a log on the far side takes to become provable here, as a sentence.
 *
 * One helper for both directions because it is one question: a `Deposit` and a
 * `Voided` are the same log on the same chain proved by the same mechanism, and
 * the two callers had drifted into quoting the same wrong constant twice.
 */
export function proofWait(deps: Deps, row: TransferRow): string {
  const source = chainOfDomain(deps.cfg, row.domain);
  const eta = source?.kind === 'evm'
    ? depositEta(source.chain)
    : source?.kind === 'sui'
      ? suiDepositEta(source.chain)
      : source?.kind === 'near'
        ? nearDepositEta(source.chain)
        : null;
  return eta?.human ?? 'a wait this chain has no measured figure for';
}
