/**
 * Assembling the frozen artifact for one withdrawal.
 *
 * Two callers need this and must not each have a copy: the script that proves a
 * withdrawal by hand, which replays the chain to reach the burn block, and the
 * indexer, which is already standing on it. The proof machinery is identical; the
 * only difference is where the tree came from.
 *
 * ## The three blocks it turns on
 *
 *   burn  the `wdlog` is here, and its leaf carries the block's action_mroot
 *   R     the first block whose certificate claims `burn`. The root it carries is
 *         therefore the tree root as of `burn`, and that is the root to submit
 *   C     the first block whose certificate claims R. It holds the signature over
 *         R's finality digest, which is what makes that root trustworthy
 *
 * R is almost always `burn + 1` and C `burn + 2`, so the artifact is complete
 * about a second after the burn — not after some batching window.
 *
 * ## Why freezing is worth it at all
 *
 * `TelosLightClient.trustedRoots` only ever accumulates, so a root accepted today
 * is still accepted in a year and an artifact built against it never expires. The
 * perishable half is the input, not the output: `submitRoot` needs the full
 * `finality_data` of R, and a node keeps that for days. Freeze inside the window
 * or the withdrawal can only be proved from the public archive.
 */

import type { SavannaChain } from '../chains/savanna.ts';
import type { IncrementalTree } from '../proof/merkle.ts';
import type { ShipBlock } from './ship.ts';
import type { ActionTrace } from './traces.ts';
import type { PolicyTracker } from './finality.ts';
import type { FinalizerPolicy } from './policyDiff.ts';
import { timestampToSlot } from '../proof/pack.ts';
import { parseQcExtension, QC_EXTENSION_ID } from './qc.ts';
import { buildReleaseProof, submitRootArgs, type ReleaseProof } from './withdrawalProof.ts';

export type WithdrawalArtifact = {
  burnBlock: number;
  rootBlock: number;
  certificateBlock: number;
  /** Makes the root trusted on Ethereum. Measured 2,395,047 gas at 21 signers. */
  submitRoot: ReturnType<typeof submitRootArgs>;
  /** The vault the withdrawal names, and so the only one whose releaser accepts it. */
  vault: string;
  /** Folds this withdrawal into that root. Hashes only, ~135k gas. */
  release: ReleaseProof;
};

/** Which blocks carry the root for a burn, and the certificate that signs it. */
export type RootBlocks = { rBlock: number; cBlock: number };

/**
 * Find R and C in a window of blocks around the burn.
 *
 * Both are found by who *claims* whom rather than by adding one and two: a block
 * that no certificate claims shifts the pair, and a proof built on the assumption
 * that R is `burn + 1` would then submit a root taken as of the wrong block.
 *
 * R is the first block claiming the burn that is itself claimed. Every block
 * claiming the burn carries the same root, but the finalizers may never certify
 * the first of them: on Telos 494039093 claimed the burn in 494039092, no block
 * ever claimed 494039093, and 494039094 — same claim, same root — was the one
 * signed.
 */
export function locateRootBlocks(window: ShipBlock[], burn: number): RootBlocks {
  const claimOf = (n: number) =>
    window.find((b) => b.this_block.block_num === n)?.finality_data?.latest_qc_claim_block_num;
  const numbers = window.map((b) => b.this_block.block_num).sort((a, b) => a - b);
  const claimerOf = (n: number) => numbers.find((m) => claimOf(m) === n);

  const candidates = numbers.filter((n) => claimOf(n) === burn);
  if (!candidates.length) {
    throw new Error(`nothing in the window around ${burn} carries a certificate claiming it`);
  }
  for (const rBlock of candidates) {
    const cBlock = claimerOf(rBlock);
    if (cBlock !== undefined) return { rBlock, cBlock };
  }
  throw new Error(
    `nothing in the window claims any of ${candidates.join(', ')}, so the root as of ${burn} is unsigned so far`,
  );
}

export type AssembleInput = {
  chain: SavannaChain;
  /** The account whose `wdlog` is being proved. */
  bridgeAccount: string;
  burn: number;
  /** Blocks covering at least `burn - 1` through C, with finality data. */
  window: ShipBlock[];
  /** Action traces of the burn block, already decoded. */
  traces: ActionTrace[];
  /**
   * A tree holding every leaf through `burn`, and the root as of it.
   *
   * The tree must be one that appended those leaves itself: the branch is made
   * of interior nodes, and a tree rebuilt from a frontier has none of them.
   */
  tree: IncrementalTree;
  rootAtBurn: string;
  /** Knows the last-pending policy digest and start slot for R's generation. */
  tracker: PolicyTracker;
  /**
   * The full policy for a generation — the one whose keys a QC bitset indexes.
   * Asked for the active generation always, and for the pending one on a
   * transition block.
   */
  policyFor: (generation: number, atBlock: number) => Promise<FinalizerPolicy>;
  /** `get_raw_block`, for the quorum certificate in C's block extensions. */
  rawBlock: (blockNum: number) => Promise<any>;
  /** Which `wdlog` of the block to prove, when it carries more than one. */
  wdlogOrdinal?: number;
};

export async function assembleWithdrawalArtifact(
  input: AssembleInput,
): Promise<WithdrawalArtifact> {
  const { chain, burn, window, tree, rootAtBurn, tracker } = input;
  const { rBlock, cBlock } = locateRootBlocks(window, burn);

  const at = new Map(window.map((b) => [b.this_block.block_num, b]));

  // Slots and digests come from whichever block claims the one in question,
  // never from a block header: state-history outlives the block log by weeks.
  const carrierOf = (n: number) => {
    const carrier = window.find((b) => b.finality_data?.latest_qc_claim_block_num === n);
    if (!carrier) throw new Error(`no certificate in the window claims block ${n}`);
    return carrier.finality_data!;
  };
  const slotOf = (n: number) => carrierOf(n).latest_qc_claim_timestamp;
  const digestOf = (n: number) => carrierOf(n).latest_qc_claim_finality_digest;
  /**
   * The parent's slot. A certificate may skip a block — none in the window then
   * claims it, and freezing such a burn failed. The slot is only a timestamp,
   * so the block's own header says it as well.
   */
  const parentSlotOf = async (n: number) => {
    if (window.some((b) => b.finality_data?.latest_qc_claim_block_num === n)) return slotOf(n);
    return timestampToSlot(chain, (await input.rawBlock(n)).timestamp);
  };

  const fdBurn = at.get(burn)?.finality_data;
  if (!fdBurn) throw new Error(`no finality data for the burn block ${burn}`);

  const { vault, proof: release } = buildReleaseProof({
    chain,
    traces: input.traces,
    bridgeAccount: input.bridgeAccount,
    block: { number: burn, timestamp: slotOf(burn), parentTimestamp: await parentSlotOf(burn - 1) },
    finalityData: fdBurn,
    finalityDigest: digestOf(burn),
    tree,
    rootHex: rootAtBurn,
    ...(input.wdlogOrdinal !== undefined ? { wdlogOrdinal: input.wdlogOrdinal } : {}),
  });

  const fdR = at.get(rBlock)?.finality_data;
  if (!fdR) throw new Error(`no finality data for the root block ${rBlock}`);

  const raw = await input.rawBlock(cBlock);
  const ext = ((raw.block_extensions ?? []) as [number, string][]).find(
    ([id]) => id === QC_EXTENSION_ID,
  );
  if (!ext) throw new Error(`block ${cBlock} carries no quorum certificate`);

  // The policy that actually signed, which the certificate's bitset indexes —
  // not necessarily the one the light client happens to hold.
  const signing = await input.policyFor(fdR.active_finalizer_policy_generation, rBlock);
  // On a transition block the pending policy signs too, and its half is proved
  // against its own keys.
  const pendingGeneration = fdR.last_pending_finalizer_policy_generation;
  const pending =
    pendingGeneration !== fdR.active_finalizer_policy_generation
      ? await input.policyFor(pendingGeneration, rBlock)
      : undefined;

  const submitRoot = submitRootArgs(
    chain,
    { finalityData: fdR, finalityMroot: rootAtBurn, timestamp: slotOf(rBlock) },
    tracker.lastPending(pendingGeneration),
    parseQcExtension(Uint8Array.from(Buffer.from(ext[1], 'hex'))),
    signing,
    pending,
  );

  return { burnBlock: burn, rootBlock: rBlock, certificateBlock: cBlock, submitRoot, vault, release };
}

/** JSON with bigints written as decimal strings, which is how the args travel. */
export const artifactToJson = (a: WithdrawalArtifact, indent = 1): string =>
  JSON.stringify(a, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), indent);
