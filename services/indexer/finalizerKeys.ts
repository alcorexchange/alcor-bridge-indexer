/**
 * Finalizer keys a withdrawal chain's light client does not know yet.
 *
 * A certificate verifies on an EVM chain only if every signer's key is in that
 * chain's `TelosLightClient`. A producer joining Telos brings a new key, and
 * until someone calls `registerKey` there, every certificate that producer signs
 * is refused: withdrawals to that chain stop. Anyone may register it, so this
 * says what to register and hands over the arguments, and whoever needs it
 * first — a user, a relayer, the operator — sends it.
 *
 * Checked against the whole register, the `regfinkey` history, and each missing
 * key says whether it is in Telos's active or pending policy. Those break
 * withdrawals now; the rest are registered producers not finalizing yet, worth
 * registering before they are.
 */

import { execFor } from '../../src/evm/exec.ts';
import { antelopeRpc } from '../../src/net/antelope.ts';
import {
  fetchRegistrations,
  keyIdOfPublicKey,
  knowsKey,
  registerKeyArgs,
} from '../../src/savanna/registrations.ts';
import type { IndexerConfig, Source } from './config.ts';
import { memo } from './memo.ts';

/** What one `registerKey` cost on Sepolia, measured. */
export const REGISTER_KEY_GAS = 470_000;

/** Registrations and policies change over days; ten minutes is fresh enough. */
const REFRESH_MS = 10 * 60_000;

export type MissingKey = {
  finalizer: string;
  keyId: string;
  /** In Telos's active or pending policy: until it is registered, withdrawals here fail. */
  inPolicy: boolean;
  registerKey: { to: string; signature: 'registerKey(bytes,bytes)'; args: [string, string]; gas: number };
};

export type ChainKeys = {
  chain: string;
  name: string;
  lightClient: string;
  known: number;
  missing: MissingKey[];
};

export type FinalizerKeys = {
  asOf: number;
  activeGeneration: number;
  chains: ChainKeys[];
  /**
   * Policy keys with no `regfinkey` in history, so no proof of possession to
   * offer. Empty unless the Hyperion endpoint is missing actions.
   */
  unknownToHistory: string[];
};

/** Where a source chain's light client is read: the endpoints its source resolved. */
export const lightClientExec = (source: Source) => execFor(source.exec);

/** `pubkeyOf` is write-once, so a key seen once is never asked about again. */
const knownForever = new Set<string>();

let current: (() => Promise<FinalizerKeys>) | undefined;

/** The current answer, recomputed at most every REFRESH_MS and once at a time. */
export function finalizerKeys(cfg: IndexerConfig): Promise<FinalizerKeys> {
  current ??= memo(REFRESH_MS, () => compute(cfg));
  return current();
}

async function compute(cfg: IndexerConfig): Promise<FinalizerKeys> {
  const [registrations, info] = await Promise.all([
    fetchRegistrations(cfg.history),
    antelopeRpc(cfg.savanna, '/v1/chain/get_finalizer_info'),
  ]);
  const policy = policyKeyIds(info);
  const registered = new Set(registrations.map((r) => r.keyId));

  // Chains in parallel, keys one at a time within a chain: a public endpoint
  // takes thirty sequential calls better than thirty at once.
  const chains = await Promise.all(
    cfg.sources
      .filter((s) => s.chain.lightClient)
      .map(async (source): Promise<ChainKeys> => {
        const { chain } = source;
        const lightClient = chain.lightClient!;
        const exec = lightClientExec(source);
        const missing: MissingKey[] = [];
        let known = 0;
        for (const r of registrations) {
          const id = `${lightClient.toLowerCase()}:${r.keyId}`;
          if (knownForever.has(id) || (await knowsKey(exec, lightClient, r.keyId))) {
            knownForever.add(id);
            known++;
            continue;
          }
          missing.push({
            finalizer: r.finalizer,
            keyId: r.keyId,
            inPolicy: policy.has(r.keyId),
            registerKey: {
              to: lightClient,
              signature: 'registerKey(bytes,bytes)',
              args: registerKeyArgs(r),
              gas: REGISTER_KEY_GAS,
            },
          });
        }
        missing.sort((a, b) => Number(b.inPolicy) - Number(a.inPolicy));
        return { chain: chain.id, name: chain.name, lightClient, known, missing };
      }),
  );

  return {
    asOf: Math.floor(Date.now() / 1000),
    activeGeneration: Number(info.active_finalizer_policy.generation),
    chains,
    unknownToHistory: [...policy].filter((k) => !registered.has(k)),
  };
}

/** Keys of the active policy and, mid-rotation, of the pending one. */
function policyKeyIds(info: any): Set<string> {
  const policies = [info.active_finalizer_policy, info.pending_finalizer_policy];
  const ids = new Set<string>();
  for (const p of policies) {
    const finalizers = p?.finalizers ?? p?.policy?.finalizers ?? [];
    for (const f of finalizers) ids.add(keyIdOfPublicKey(f.public_key));
  }
  return ids;
}
