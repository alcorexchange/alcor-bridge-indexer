/**
 * The certificate that carries a finalizer-policy handover, assembled and checked.
 *
 * Telos opens a two-block window at every rotation:
 *
 *   block P      the new policy becomes PENDING here, and the block's finality
 *                digest commits to sha256 of it
 *   block P+1    same
 *   block P+2    the new policy becomes ACTIVE; the window has closed
 *
 * A certificate over P carries two halves, one by the generation still active
 * and one by the pending one, and Spring counts P final only if both reach their
 * threshold. `TelosLightClient.submitRoot` checks both, and in doing so records
 * what the successor hashes to — which is what `installPolicy` stands on.
 *
 * Two callers need exactly this and must not each have a copy: the script that
 * advances a light client, and the one that freezes the handover into a test
 * fixture.
 */

import type { SavannaChain } from '../chains/savanna.ts';
import { antelopeRpc } from '../net/antelope.ts';
import { timestampToSlot } from '../proof/pack.ts';
import { finalityDigest } from './finality.ts';
import { findPolicyPublication } from './policyChain.ts';
import { policyDigest, type FinalizerPolicy } from './policyDiff.ts';
import { parseQcExtension, verifyQc, QC_EXTENSION_ID, type Qc, type QcVerdict } from './qc.ts';
import { fetchFinalityRange } from './ship.ts';
import { submitRootArgs, type SubmitRootArgs } from './withdrawalProof.ts';

export type Handover = {
  /** P: where `next` became pending. */
  block: number;
  /** The block whose certificate claims P. */
  carrierBlock: number;
  /** The generation active at P, which signs the active half. */
  previous: FinalizerPolicy;
  /** The generation becoming pending at P, which signs the pending half. */
  next: FinalizerPolicy;
  qc: Qc;
  args: SubmitRootArgs;
  /** Both halves verified locally against the digest the chain reports as signed. */
  check: QcVerdict;
};

/** Find the handover to `generation`, which must be within state-history retention. */
export async function buildHandover(
  chain: SavannaChain,
  ship: string,
  head: number,
  generation: number,
): Promise<Handover> {
  const published = await findPolicyPublication(ship, head, generation);
  return assembleHandover(chain, ship, published.block, published.policy, async (g) =>
    (await findPolicyPublication(ship, head, g)).policy,
  );
}

/**
 * Assemble the handover at `block`, where `next` became pending.
 *
 * For a caller that already knows where each policy was published — the
 * indexer, which watched them go by — and so needs none of the binary searches
 * `buildHandover` runs. `policyOf` supplies the generation still active at
 * `block`, which the block itself names. The window read here must still be
 * within retention.
 */
export async function assembleHandover(
  chain: SavannaChain,
  ship: string,
  block: number,
  next: FinalizerPolicy,
  policyOf: (generation: number) => Promise<FinalizerPolicy>,
): Promise<Handover> {
  const window = await fetchFinalityRange(ship, block - 1, block + 8);
  const fd = window.find((b) => b.this_block.block_num === block)?.finality_data;
  if (!fd) throw new Error(`no finality data for block ${block}`);
  if (fd.active_finalizer_policy_generation === fd.last_pending_finalizer_policy_generation) {
    throw new Error(`block ${block} is not a transition block`);
  }
  if (fd.last_pending_finalizer_policy_generation !== next.generation) {
    throw new Error(`block ${block} makes generation ${fd.last_pending_finalizer_policy_generation} pending, not ${next.generation}`);
  }
  const previous = await policyOf(fd.active_finalizer_policy_generation);

  const carrier = window.find((b) => b.finality_data?.latest_qc_claim_block_num === block);
  if (!carrier) throw new Error(`nothing within 8 blocks carries a certificate claiming ${block}`);
  const carrierBlock = carrier.this_block.block_num;

  const header = await antelopeRpc(chain, '/v1/chain/get_block', { block_num_or_id: block });
  const raw = await antelopeRpc(chain, '/v1/chain/get_raw_block', { block_num_or_id: carrierBlock });
  const ext = ((raw.block_extensions ?? []) as [number, string][]).find(([id]) => id === QC_EXTENSION_ID);
  if (!ext) throw new Error(`block ${carrierBlock} carries no quorum certificate`);
  const qc = parseQcExtension(Uint8Array.from(Buffer.from(ext[1], 'hex')));

  // The policy becoming pending here IS the last-pending policy for this block,
  // and its start is this block's own timestamp.
  const slot = timestampToSlot(chain, header.timestamp);
  const args = submitRootArgs(
    chain,
    { finalityData: fd, finalityMroot: header.action_mroot, timestamp: slot },
    { digest: policyDigest(next), startSlot: slot },
    qc,
    previous,
    next,
  );
  // The digest these arguments rebuild must be the one the chain reports as
  // signed for P. That is what ties the pending policy's hash — and so its
  // bytes — to the certificate, rather than to this function's own inputs.
  const signedDigest = carrier.finality_data!.latest_qc_claim_finality_digest;
  const rebuilt = finalityDigest(chain, {
    finalityData: fd,
    finalityMroot: header.action_mroot,
    timestamp: slot,
    lastPendingPolicyDigest: policyDigest(next),
    lastPendingPolicyStartSlot: slot,
  });
  if (rebuilt !== signedDigest) {
    throw new Error(`block ${block}: rebuilt digest ${rebuilt}, the chain signed ${signedDigest}`);
  }
  const check = verifyQc(qc, previous, next, Uint8Array.from(Buffer.from(signedDigest, 'hex')));

  return { block, carrierBlock, previous, next, qc, args, check };
}
