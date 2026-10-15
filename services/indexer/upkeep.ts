/**
 * The maintenance the bridge needs, and the transactions that do it.
 *
 * Three things keep the far chains able to verify Telos and Telos able to
 * verify them, and none of them needs anyone's permission:
 *
 *   policy      each EVM `TelosLightClient` follows Telos's finalizer policy one
 *               generation at a time, by a `submitRoot` of the certificate from
 *               the rotation's handover window and an `installPolicy` of the
 *               policy it vouched for
 *   keys        a finalizer key an EVM light client has never seen, taught to it
 *               by `registerKey` with its proof of possession
 *   consensus   what the Telos-side light client for each source chain needs —
 *               a sync committee per period on Ethereum, a validator set per
 *               epoch on BSC — which the relayer services push
 *
 * The first two are EVM transactions anyone can send, so this hands over the
 * arguments ready to send and a front end can offer them to whoever is there.
 * The third is reported for display: it is a Telos transaction the relayer
 * keeps current, and a lag there is an operator's problem rather than a user's.
 */

import { selector, type Exec } from '../../src/evm/exec.ts';
import { antelopeRpc, getInfo } from '../../src/net/antelope.ts';
import { policyStatus, POLICY_LAG_ALARM } from '../../src/status.ts';
import { unpackFinalizerPolicy } from '../../src/savanna/policyDiff.ts';
import { keyIdOf, keyIdOfPublicKey } from '../../src/savanna/registrations.ts';
import { frozenSubmitRoot, SUBMIT_ROOT_SIG, type SubmitRootArgs } from '../../src/savanna/withdrawalProof.ts';
import { upkeepOf } from './chains.ts';
import type { IndexerConfig } from './config.ts';
import type { Store } from './db.ts';
import { finalizerKeys, lightClientExec } from './finalizerKeys.ts';
import { memo } from './memo.ts';

/** `submitRoot` of a handover certificate, which checks two quorums: 1,971,181 on mainnet, generation 152. */
export const HANDOVER_SUBMIT_GAS = 2_200_000;
/** `installPolicy` of 21 finalizers: 358k, measured. */
export const INSTALL_POLICY_GAS = 400_000;

/** A generation moves twice a day; a minute keeps a finished step from being offered for long. */
const REFRESH_MS = 60_000;

/**
 * How long a finalizer may be out of Telos's policy and still count as there.
 * The standby rotation takes a seat for twelve hours and hands it back; one
 * out for a whole day has left.
 */
const AWAY_SECONDS = 24 * 60 * 60;
/** Telos makes two blocks a second. */
const TELOS_BLOCKS_PER_SECOND = 2;
/** Spare weight at which advancing the policy is offered; at none it is urgent. */
const OFFER_AT_SPARE = 2;

export type PolicyStep = {
  /** The generation this step installs. */
  generation: number;
  /** The Telos block where it became pending. */
  telosBlock: number;
  /** Send first. Records the successor's digest from a certificate both generations signed. */
  submitRoot: { to: string; signature: string; args: SubmitRootArgs; gas: number };
  /** Send second. The packed policy, accepted because its sha256 matches what `submitRoot` recorded. */
  installPolicy: { to: string; signature: 'installPolicy(bytes)'; args: [string]; gas: number };
};

export type ChainUpkeep = {
  chain: string;
  name: string;
  lightClient: string | null;
  policy: {
    /** The generation the EVM light client holds. */
    held: number;
    /** The generation active on Telos. */
    active: number;
    /** Generations behind. One is a rotation not followed yet; two or more is an alarm. */
    lag: number;
    /**
     * Every step that can be taken now, oldest first, and each only after the one
     * before it has landed: a handover is signed by the generation it hands over
     * from, which the light client has to hold.
     */
    steps: PolicyStep[];
    /** Why `steps` stops short of `active`, when it does. */
    blocked?: string;
    /**
     * Whether the held seats still carry a quorum. A withdrawal verifies when
     * its certificate's signers hold `threshold` of the held seats' weight, so
     * what matters is how many of those finalizers still sign — not how many
     * generations have passed. Null when it could not be read.
     */
    quorum: {
      threshold: number;
      /** Weight of the held seats whose finalizers were in Telos's policy within the last day. */
      present: number;
      /** `present − threshold`: how many more of them can leave before withdrawals need the policy advanced. */
      spare: number;
    } | null;
  } | null;
  keys: {
    known: number;
    missing: number;
    /** Missing keys that sign for Telos now. Each one is a signer a withdrawal proof cannot use. */
    inPolicy: number;
  } | null;
  /** The Telos-side light client for this chain, as `/v1/chains` reports it under `upkeep`. */
  consensus: Record<string, unknown> | null;
  errors: string[];
};

export type Todo = {
  chain: string;
  action: 'advancePolicy' | 'registerKey' | 'updcommit' | 'updateset';
  count: number;
  /** Withdrawals or deposits are failing, or about to, until this is done. */
  urgent: boolean;
  /** Whether a front end can offer it: EVM transactions anyone may send. */
  anyone: boolean;
};

export type Upkeep = { asOf: number; todo: Todo[]; chains: ChainUpkeep[] };

let current: (() => Promise<Upkeep>) | undefined;

export function upkeep(cfg: IndexerConfig, store: Store): Promise<Upkeep> {
  current ??= memo(REFRESH_MS, () => compute(cfg, store));
  return current();
}

async function compute(cfg: IndexerConfig, store: Store): Promise<Upkeep> {
  const withClient = cfg.sources.map((s) => s.chain).filter((c) => c.lightClient);
  const [policies, keys] = await Promise.all([
    policyStatus(cfg.savanna, withClient).catch((err: Error) => err),
    finalizerKeys(cfg).catch((err: Error) => err),
  ]);

  const recent = recentFinalizers(cfg, store).catch((err: Error) => err);

  const chains = await Promise.all(
    cfg.sources.map(async (source): Promise<ChainUpkeep> => {
      const { chain, accounts } = source;
      const errors: string[] = [];

      let policy: ChainUpkeep['policy'] = null;
      if (chain.lightClient) {
        if (policies instanceof Error) errors.push(`policy: ${policies.message}`);
        else {
          const { held, active, lag } = policies.find((x) => x.chain === chain.id)!;
          const finalizers = await recent;
          const quorum =
            finalizers instanceof Error
              ? finalizers
              : await heldQuorum(lightClientExec(source), chain.lightClient, held, finalizers).catch(
                  (err: Error) => err,
                );
          if (quorum instanceof Error) errors.push(`quorum: ${quorum.message}`);
          policy = {
            held,
            active,
            lag,
            ...policySteps(store, chain.lightClient, held, active),
            quorum: quorum instanceof Error ? null : quorum,
          };
        }
      }

      let keyCounts: ChainUpkeep['keys'] = null;
      if (keys instanceof Error) errors.push(`keys: ${keys.message}`);
      else {
        const k = keys.chains.find((x) => x.chain === chain.id);
        if (k) {
          keyCounts = {
            known: k.known,
            missing: k.missing.length,
            inPolicy: k.missing.filter((m) => m.inPolicy).length,
          };
        }
      }

      const consensus = await upkeepOf(cfg, chain, accounts).catch((err: Error) => {
        errors.push(`consensus: ${err.message}`);
        return null;
      });

      return {
        chain: chain.id,
        name: chain.name,
        lightClient: chain.lightClient ?? null,
        policy,
        keys: keyCounts,
        consensus,
        errors,
      };
    }),
  );

  return { asOf: Math.floor(Date.now() / 1000), todo: chains.flatMap(todoOf), chains };
}

/**
 * Keys of every finalizer in Telos's policy at some point in the last day:
 * the active policy, and each one before it that was still active a day ago,
 * read from the stored handovers. `all` when the oldest of those is not stored
 * — a light client holding that generation has every one of its seats there.
 */
async function recentFinalizers(
  cfg: IndexerConfig,
  store: Store,
): Promise<{ keys: Set<string>; since: number; complete: boolean }> {
  const [info, chainInfo] = await Promise.all([
    antelopeRpc(cfg.savanna, '/v1/chain/get_finalizer_info'),
    getInfo(cfg.savanna),
  ]);
  const keys = new Set<string>();
  for (const p of [info.active_finalizer_policy, info.pending_finalizer_policy]) {
    for (const f of p?.finalizers ?? p?.policy?.finalizers ?? []) keys.add(keyIdOfPublicKey(f.public_key));
  }
  const dayAgo = Number(chainInfo.head_block_num) - AWAY_SECONDS * TELOS_BLOCKS_PER_SECOND;
  // Generation g−1 was active until g's handover; it counts while that is within the day.
  let generation = Number(info.active_finalizer_policy.generation);
  for (let into = store.getHandover(generation); into && into.block > dayAgo; into = store.getHandover(--generation)) {
    const before = store.getHandover(generation - 1);
    if (!before) return { keys, since: generation - 1, complete: false };
    const packed = (JSON.parse(before.body) as { submitRoot: SubmitRootArgs }).submitRoot.pending.policy;
    for (const f of unpackFinalizerPolicy(Buffer.from(packed.replace(/^0x/, ''), 'hex')).finalizers) {
      keys.add(keyIdOf(f.publicKey));
    }
  }
  return { keys, since: generation, complete: true };
}

/** A key's held weight never changes within a held generation, so it is read once per generation. */
const weightCache = new Map<string, number>();

/**
 * The held seats' weight among finalizers seen within the day, against the
 * light client's own threshold.
 *
 * When the day reaches back to a generation with no stored handover and that
 * generation is the one held, every held seat was in the policy within the day.
 */
async function heldQuorum(
  exec: Exec,
  lightClient: string,
  held: number,
  recent: { keys: Set<string>; since: number; complete: boolean },
): Promise<NonNullable<NonNullable<ChainUpkeep['policy']>['quorum']>> {
  const read = async (signature: string, arg = '') =>
    Number(BigInt(await exec.rpc('eth_call', [{ to: lightClient, data: selector(signature) + arg }, 'latest'])));
  const [threshold, total] = await Promise.all([read('threshold()'), read('coreTotalWeight()')]);
  if (!recent.complete && recent.since <= held) return { threshold, present: total, spare: total - threshold };

  let present = 0;
  for (const keyId of recent.keys) {
    const cacheKey = `${lightClient.toLowerCase()}:${held}:${keyId}`;
    let weight = weightCache.get(cacheKey);
    if (weight === undefined) {
      weight = await read('coreWeightOf(bytes32)', keyId.replace(/^0x/, ''));
      weightCache.set(cacheKey, weight);
    }
    present += weight;
  }
  return { threshold, present, spare: present - threshold };
}

/**
 * The stored handovers from `held + 1` on, until the first one missing.
 *
 * Blocked when that first missing one is a generation Telos has already
 * activated: the light client needs it and nothing here can supply it.
 */
function policySteps(
  store: Store,
  lightClient: string,
  held: number,
  active: number,
): { steps: PolicyStep[]; blocked?: string } {
  const steps: PolicyStep[] = [];
  let generation = held + 1;
  for (let stored = store.getHandover(generation); stored; stored = store.getHandover(++generation)) {
    const args = frozenSubmitRoot((JSON.parse(stored.body) as { submitRoot: SubmitRootArgs }).submitRoot);
    steps.push({
      generation,
      telosBlock: stored.block,
      submitRoot: { to: lightClient, signature: SUBMIT_ROOT_SIG, args, gas: HANDOVER_SUBMIT_GAS },
      installPolicy: {
        to: lightClient,
        signature: 'installPolicy(bytes)',
        args: [args.pending.policy],
        gas: INSTALL_POLICY_GAS,
      },
    });
  }
  if (generation > active) return { steps };
  return {
    steps,
    blocked:
      `no handover stored for generation ${generation}; the indexer builds one a few seconds ` +
      `after publication, and once state-history has pruned it only the policy admin's ` +
      `setPolicy can move the light client past it`,
  };
}

function todoOf(c: ChainUpkeep): Todo[] {
  const out: Todo[] = [];
  // Maintenance, not a prerequisite: a withdrawal verifies against the
  // certificate's own signers while the held seats keep a quorum. Offered once
  // finalizers have really left — out of the policy a whole day, not rotated
  // out for twelve hours — and urgent when the quorum is gone. Without a
  // reading of the quorum, the generation count stands in for it.
  const quorum = c.policy?.quorum;
  if (c.policy && c.policy.lag > 0 && (!quorum || quorum.spare <= OFFER_AT_SPARE)) {
    out.push({
      chain: c.chain,
      action: 'advancePolicy',
      count: c.policy.lag,
      urgent: quorum ? quorum.spare <= 0 : c.policy.lag >= POLICY_LAG_ALARM,
      anyone: c.policy.steps.length > 0,
    });
  }
  // Only keys that sign for Telos now: until registered, every certificate they
  // sign is refused there. A registered producer not finalizing needs nothing yet.
  if (c.keys && c.keys.inPolicy > 0) {
    out.push({
      chain: c.chain,
      action: 'registerKey',
      count: c.keys.inPolicy,
      urgent: true,
      anyone: true,
    });
  }
  const lag = Number(c.consensus?.lag ?? 0);
  const action = c.consensus?.action;
  if (lag > 0 && (action === 'updcommit' || action === 'updateset')) {
    out.push({
      chain: c.chain,
      action,
      count: lag,
      // Neither a committee nor a BSC validator set can be skipped, and each
      // signs nothing past its successor's start: two behind and proofs stop.
      urgent: lag > 1,
      anyone: false,
    });
  }
  return out;
}
