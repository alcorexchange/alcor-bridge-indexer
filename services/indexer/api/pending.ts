/**
 * `/v1/pending`: everything waiting for somebody to sign a transaction, and
 * whether it can be signed now.
 */

import { depositEta, humanEta } from '../../../src/chains/eta.ts';
import { epochBacklog } from '../../../src/bsc/parlia.ts';
import { SETTLEMENT_CHAIN, chainOfDomain } from '../config.ts';
import { BOOKED, voidKey, type TransferRow } from '../db.ts';
import { confirmationsLeft, fastVerdict, routeFor } from '../fast.ts';
import { finalizerKeys } from '../finalizerKeys.ts';
import { committeeSoon } from './cache.ts';
import { ancestryDeadline, followerOf, proofWait, type Deps } from './deps.ts';
import { exact, json, type Route } from './http.ts';
import { decorate } from './transfers.ts';

export const pendingRoutes: Route[] = [
  {
    shown: '/v1/pending',
    match: exact('/v1/pending'),
    handle: async ({ deps, q }) => json(200, await pending(deps, {
      account: q.get('account') ?? undefined,
      address: q.get('address') ?? undefined,
      chain: q.get('chain') ?? undefined,
      readyOnly: q.get('ready') === 'true',
    })),
  },
];

export type PendingPush = {
  key: string;
  direction: string;
  /** The action a wallet would sign, in words. */
  action: string;
  /** Which chain it goes to: `telos`, or a far chain by its registry id. */
  pushOn: string;
  /** True when the proof is stored and the transaction can be built right now. */
  ready: boolean;
  reason: string;
  proof: string | null;
  account: string | null;
  evmAddress: string | null;
  amount: string | null;
  /** What `amount` is in, on a transfer's item; null for a token this build has no listing for. */
  symbol?: string | null;
  precision?: number | null;
  /** Set when there is a clock on it. */
  deadline?: { at: number; secondsLeft: number; what: string };
  /** For an operator rather than a user. */
  admin?: boolean;
};

/**
 * Everything that is currently waiting for somebody to sign a transaction.
 *
 * This is the whole point of an observer that does not push: it knows exactly
 * what is outstanding, on which chain, and whether the proof for it already
 * exists — so a user can finish their own crossing and an operator can see the
 * queue, without either of them holding a key this service also holds.
 *
 * `ready: false` items are listed too, with the reason. A deposit waiting for
 * finality is not a problem; a deposit waiting for finality that has been
 * waiting nine hours is, and only listing the ready ones hides it.
 */
async function pending(
  deps: Deps,
  filter: { account?: string; address?: string; chain?: string; readyOnly?: boolean },
): Promise<{ pending: PendingPush[]; count: number; asOf: number }> {
  const now = Math.floor(Date.now() / 1000);
  const out: PendingPush[] = [];

  const rows = deps.store.listTransfers({
    account: filter.account,
    address: filter.address,
    limit: 500,
  });

  for (const r of rows) {
    const d = decorate(deps, r);
    const far = chainOfDomain(deps.cfg, r.domain);
    // Who and how much, the same on every transfer's item.
    const transfer = {
      account: r.account,
      evmAddress: r.evm_address,
      amount: r.amount,
      symbol: d.symbol,
      precision: d.precision,
    };

    if (r.direction === 'deposit' && BOOKED.includes(r.status)) continue;

    // A deposit from an Antelope chain is proved by that chain's relayer, not
    // pushed from here: there is no proof to offer, no fast path and no
    // ancestry deadline — only how far its producers have got.
    if (r.direction === 'deposit' && (far?.kind === 'antelope' || far?.kind === 'sui' || far?.kind === 'near')) {
      out.push({
        key: r.key,
        direction: 'deposit',
        action: `proved by the ${far.chain.name} relayer`,
        pushOn: SETTLEMENT_CHAIN,
        ready: false,
        reason: d.progress.stage,
        proof: null,
        ...transfer,
      });
      continue;
    }

    if (r.direction === 'deposit') {
      // Whether the fast proof is on offer, from numbers already in hand: the
      // EVM head and the route's limits. Building one to find out would be a
      // beacon round trip per row per poll.
      const fast = await fastReady(deps, r);
      const ready = d.hasProof || fast.ready;
      // The deposit side's own deadline, and on a beacon chain the tight one.
      const expires = ready ? undefined : ancestryDeadline(deps.cfg, r);
      out.push({
        key: r.key,
        direction: 'deposit',
        action: fast.ready
          ? `proveroot + credit (fast, ${fast.confirmations} confirmations)`
          : d.hasProof
            ? 'proveroot + credit (finalized)'
            : 'waiting',
        pushOn: SETTLEMENT_CHAIN,
        ready,
        reason: fast.ready
          ? 'enough confirmations proved for this route; it can be credited now'
          : d.hasProof
            ? 'proved and not yet credited on the settlement chain'
            : fast.reason,
        proof: ready ? `/v1/proofs/${r.key}` : null,
        ...transfer,
        ...(expires === undefined
          ? {}
          : {
              deadline: {
                at: expires,
                secondsLeft: expires - now,
                what: 'after this the ancestry no longer fits in one transaction',
              },
            }),
      });
      continue;
    }

    if (r.status === 'released' || r.status === 'refunded') continue;

    // Bound for an Antelope chain: its relayer releases it — or expires it
    // past the deadline — with a proof of its own, so nothing here is pushed
    // by anyone else and no EVM artifact is ever stored for it.
    if (far?.kind === 'antelope') {
      out.push({
        key: r.key,
        direction: 'withdrawal',
        action: `released by the ${far.chain.name} relayer`,
        pushOn: far.chain.id,
        ready: false,
        reason: d.progress.stage,
        proof: null,
        ...transfer,
      });
      continue;
    }

    // Rolled back on the far side: what is outstanding is the refund at home,
    // and it needs the vault's `Voided` log proved on the settlement chain.
    if (r.status === 'expired' && (far?.kind === 'sui' || far?.kind === 'near')) {
      out.push({
        key: voidKey(r.ref),
        direction: 'withdrawal-rollback',
        action: `reissued by the ${far.chain.name} relayer`,
        pushOn: SETTLEMENT_CHAIN,
        ready: false,
        reason: far.kind === 'sui'
          ? 'expired on Sui; the relayer proves the Voided event and the burned amount is reissued'
          : `expired on ${far.chain.name}; the relayer proves the voided log and the burned amount is reissued`,
        proof: null,
        ...transfer,
      });
      continue;
    }
    if (r.status === 'expired') {
      const vk = voidKey(r.ref);
      const ready = deps.store.hasProof(vk);
      out.push({
        key: vk,
        direction: 'withdrawal-rollback',
        action: ready ? 'proveroot + voided' : 'waiting for finality',
        pushOn: SETTLEMENT_CHAIN,
        ready,
        reason: ready
          ? 'voided on the far side; the burned amount can be reissued'
          // The Voided log is on the FAR side, so this is that chain's
          // finality and not ours — seconds on BSC, a quarter hour on Ethereum.
          : `the Voided log has not finalized yet — ${proofWait(deps, r)}`,
        proof: ready ? `/v1/proofs/${vk}` : null,
        ...transfer,
      });
      continue;
    }

    const pastDeadline = r.deadline !== null && r.deadline <= now;
    out.push({
      key: r.key,
      direction: pastDeadline ? 'withdrawal-expire' : 'withdrawal',
      action: far?.kind === 'sui'
        ? (pastDeadline ? 'submit_root_entry + expire_entry' : 'submit_root_entry + release_entry')
        : far?.kind === 'near'
          ? (pastDeadline ? 'submit_root + expire' : 'submit_root + release')
          : pastDeadline
          ? 'expire'
          : d.track === 'light'
            ? 'release (~135k gas)'
            : 'submitRoot + release (~2.6M gas)',
      // The chain the withdrawal is BOUND FOR, from the row's own domain —
      // not this instance's own chain. With one source they were the same
      // string, which is exactly why it went unnoticed; with four, a BSC
      // withdrawal was being labelled `sepolia`.
      pushOn: far?.chain.id ?? `domain ${r.domain}`,
      ready: d.hasProof,
      reason: pastDeadline
        ? 'past its deadline: release is refused, expire is what unlocks the refund'
        : d.hasProof
          ? 'burned and not yet released'
          : 'burned, and no proof is stored — this is the one with a clock on it',
      proof: d.hasProof ? `/v1/proofs/${r.key}` : null,
      ...transfer,
      ...(r.deadline && !pastDeadline
        ? {
            deadline: {
              at: r.deadline,
              secondsLeft: r.deadline - now,
              what: 'after this it can no longer be claimed, only cancelled and refunded on Telos',
            },
          }
        : {}),
    });
  }

  // The operator's item. Not a transfer, and the one rotation that cannot skip:
  // a committee is only provable by the one before it, so a backlog has to be
  // walked one period at a time before beacon nodes prune the updates.
  if (!filter.account && !filter.address && deps.cfg.evm.strategy === 'parlia') {
    const e = await epochBacklog(deps.cfg).catch(() => null);
    if (e && e.lag > 0) {
      out.push({
        key: `vsets:${e.stored + (deps.cfg.evm.epochLength ?? 0)}`,
        direction: 'validators',
        action: `updateset × ${e.lag}`,
        pushOn: SETTLEMENT_CHAIN,
        ready: true,
        reason:
          `the light client holds epoch ${e.stored} and the chain is on ${e.head}. ` +
          `Sets are chained and cannot be jumped; install them in order with updateset`,
        proof: null,
        account: null,
        evmAddress: null,
        amount: null,
        admin: true,
      });
    }
  }

  if (!filter.account && !filter.address && deps.cfg.evm.strategy === 'beacon') {
    const c = await committeeSoon(deps).catch(() => null);
    if (c && c.lagPeriods > 0) {
      out.push({
        key: `committee:${c.stored + 1}`,
        direction: 'committee',
        action: `updcommit × ${c.lagPeriods}`,
        pushOn: SETTLEMENT_CHAIN,
        ready: true,
        reason:
          `the light client holds period ${c.stored} and the chain is on ${c.head}. ` +
          `Rotations cannot be skipped; push updcommit once per period`,
        proof: null,
        account: null,
        evmAddress: null,
        amount: null,
        admin: true,
      });
    }
  }

  // A finalizer key a withdrawal chain has never seen. Not an operator's item:
  // anyone may register it, and until someone does, every certificate that
  // finalizer signs is refused there, so every withdrawal to that chain waits.
  if (!filter.account && !filter.address) {
    const keys = await finalizerKeys(deps.cfg).catch(() => null);
    for (const c of keys?.chains ?? []) {
      for (const k of c.missing.filter((m) => m.inPolicy)) {
        out.push({
          key: `finkey:${c.chain}:${k.keyId}`,
          direction: 'finalizer-key',
          action: 'registerKey',
          pushOn: c.chain,
          ready: true,
          reason:
            `${k.finalizer} finalizes Telos and ${c.name}'s light client does not know its key: ` +
            `withdrawals there fail until it is registered. Anyone may, about ${k.registerKey.gas.toLocaleString('en-US')} gas`,
          proof: `/v1/finalizer-keys?chain=${c.chain}`,
          account: null,
          evmAddress: null,
          amount: null,
        });
      }
    }
  }

  const filtered = out.filter(
    (p) => (!filter.readyOnly || p.ready) && (!filter.chain || p.pushOn === filter.chain),
  );
  return { pending: filtered, count: filtered.length, asOf: now };
}

/**
 * Is the fast path on offer for this deposit, without building it?
 *
 * Confirmations and the route's limits answer it, and both are already here —
 * the EVM head from the follower, the route from a cached table read. Building
 * the bundle to find out would be several beacon requests per row per poll.
 */
async function fastReady(
  deps: Deps,
  row: TransferRow,
): Promise<{ ready: boolean; confirmations: number; reason: string }> {
  const source = chainOfDomain(deps.cfg, row.domain);
  const follower = followerOf(deps, row.domain);
  if (source?.kind !== 'evm' || !follower) {
    return {
      ready: false,
      confirmations: 0,
      reason: `domain ${row.domain} is not a source chain this instance follows`,
    };
  }
  const { chain } = source;
  const confirmations = Math.max(0, follower.state.head - row.src_block);
  const wait = proofWait(deps, row);

  if (!row.token || !row.amount) {
    return { ready: false, confirmations, reason: `waiting on finality: ${wait}` };
  }

  // The fast path proves the deposit's OWN block against a beacon chain, so it
  // exists only where the source chain has one. BSC and Polygon are final in
  // seconds through their own provers, and there is no fast path to offer.
  if (chain.strategy !== 'beacon') {
    const eta = depositEta(chain);
    const frontier = follower.state.provableUpTo;
    // Two halves, and a depositor can tell them apart only if we say which one
    // they are in: before the prover's frontier reaches their block there is
    // nothing to prove against; after it, only the push is left.
    const arrived = frontier >= 0 && row.src_block <= frontier;
    if (!arrived) {
      return { ready: false, confirmations, reason: `${eta.parts[0].what} — ${wait}` };
    }
    const left = eta.parts.slice(1).reduce((a, p) => a + p.seconds, 0);
    const next = eta.parts[1].what;
    return {
      ready: false,
      confirmations,
      reason: `the evidence is in; now ${next} — about ${humanEta(left)} more`,
    };
  }

  try {
    const fast = fastVerdict(await routeFor(deps.cfg, row.token, String(chain.chainId)), BigInt(row.amount), confirmations);
    if (!fast.offered) return { ready: false, confirmations, reason: `${fast.reason}; waiting for finality — ${wait}` };
    if (fast.left > 0) return { ready: false, confirmations, reason: confirmationsLeft(fast, chain.blockTime) };
    return { ready: true, confirmations, reason: '' };
  } catch (err) {
    return { ready: false, confirmations, reason: `route unknown: ${(err as Error).message}` };
  }
}
