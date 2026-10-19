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
 * P+1 does exactly as well: it too is a transition block, its digest commits to
 * the same pending policy with the same start (P's timestamp), and the light
 * clients ask only that the block be one. Some rotations need it: nothing ever
 * claimed 494430000, where generation 195 became pending — 494430001 claimed
 * 494429999 — while 494430002 claimed 494430001. A handover built from P alone
 * was impossible there, and every light client would have been stuck at 194.
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
import { fetchFinalityRange, type ShipBlock } from './ship.ts';
import { submitRootArgs, type SubmitRootArgs } from './withdrawalProof.ts';

export type Handover = {
  /** P: where `next` became pending. */
  block: number;
  /** The transition block the certificate claims: P, or P+1 when nothing claims P. */
  transition: number;
  /** The block whose certificate claims `transition`. */
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

  const certified = certifiedTransition(window, block);
  if (!certified) throw new Error(`nothing within 8 blocks carries a certificate claiming a block of the window at ${block}`);
  const transition = certified.transition.this_block.block_num;
  const transitionFd = certified.transition.finality_data!;
  const carrierBlock = certified.carrier.this_block.block_num;

  const published = await antelopeRpc(chain, '/v1/chain/get_block', { block_num_or_id: block });
  const header = transition === block
    ? published
    : await antelopeRpc(chain, '/v1/chain/get_block', { block_num_or_id: transition });
  const raw = await antelopeRpc(chain, '/v1/chain/get_raw_block', { block_num_or_id: carrierBlock });
  const ext = ((raw.block_extensions ?? []) as [number, string][]).find(([id]) => id === QC_EXTENSION_ID);
  if (!ext) throw new Error(`block ${carrierBlock} carries no quorum certificate`);
  const qc = parseQcExtension(Uint8Array.from(Buffer.from(ext[1], 'hex')));

  // The pending policy's start is P's timestamp whichever block of the window
  // is certified; the block's own fields are the transition block's.
  const startSlot = timestampToSlot(chain, published.timestamp);
  const slot = timestampToSlot(chain, header.timestamp);
  const args = submitRootArgs(
    chain,
    { finalityData: transitionFd, finalityMroot: header.action_mroot, timestamp: slot },
    { digest: policyDigest(next), startSlot },
    qc,
    previous,
    next,
  );
  // The digest these arguments rebuild must be the one the chain reports as
  // signed for the transition block. That is what ties the pending policy's
  // hash — and so its bytes — to the certificate, rather than to this
  // function's own inputs.
  const signedDigest = certified.carrier.finality_data!.latest_qc_claim_finality_digest;
  const rebuilt = finalityDigest(chain, {
    finalityData: transitionFd,
    finalityMroot: header.action_mroot,
    timestamp: slot,
    lastPendingPolicyDigest: policyDigest(next),
    lastPendingPolicyStartSlot: startSlot,
  });
  if (rebuilt !== signedDigest) {
    throw new Error(`block ${transition}: rebuilt digest ${rebuilt}, the chain signed ${signedDigest}`);
  }
  const check = verifyQc(qc, previous, next, Uint8Array.from(Buffer.from(signedDigest, 'hex')));

  return { block, transition, carrierBlock, previous, next, qc, args, check };
}

/**
 * The first block of the window opened at `block` that a later block's
 * certificate claims, with that later block: P, else P+1. The window is the
 * run of blocks from P on whose policy is still pending and not yet active.
 */
export function certifiedTransition(
  window: ShipBlock[],
  block: number,
): { transition: ShipBlock; carrier: ShipBlock } | undefined {
  const byNumber = [...window].sort((a, b) => a.this_block.block_num - b.this_block.block_num);
  const opened = byNumber.find((b) => b.this_block.block_num === block)?.finality_data;
  if (!opened) return undefined;
  for (const b of byNumber) {
    const fd = b.finality_data;
    if (b.this_block.block_num < block || !fd) continue;
    const pending = fd.last_pending_finalizer_policy_generation;
    if (pending !== opened.last_pending_finalizer_policy_generation || fd.active_finalizer_policy_generation === pending) break;
    const carrier = byNumber.find((c) => c.finality_data?.latest_qc_claim_block_num === b.this_block.block_num);
    if (carrier) return { transition: b, carrier };
  }
  return undefined;
}
