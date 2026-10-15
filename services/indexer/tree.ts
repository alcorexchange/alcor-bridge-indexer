/**
 * Rebuilding a tree locally, and moving an old proof onto a newer root.
 *
 * Both of these used to mean replaying state-history. With the leaf window on
 * disk they are local work: a checkpoint gives the frontier, the leaf file gives
 * everything after it, and appending 32-byte hashes is hashing, not networking.
 * Fifty thousand leaves is milliseconds here and was a minute over a socket.
 *
 * ## Why re-branching is worth the code
 *
 * `AlcorWithdrawals._verify` checks `lightClient.trustedRoots(p.finalityMroot)`
 * and nothing else about which root it is. `trustedRoots` only ever accumulates.
 * So a withdrawal may settle against any root taken at or after its burn block,
 * and folding into one that somebody already paid for costs 135k gas instead of
 * the ~2.4M a `submitRoot` of its own costs.
 *
 * Everything else in the frozen artifact survives the move: the payload, the
 * action branch and the seven leaf fields are facts about the block. Only the
 * tree branch and the root it names change.
 */

import { finalityLeafBytes } from '../../src/savanna/tree.ts';
import { toSolidityBranch } from '../../src/savanna/withdrawalProof.ts';
import { foldProof } from '../../src/proof/merkle.ts';
import { newestCheckpointAtOrBefore } from '../../src/savanna/frontier.ts';
import type { IncrementalTree } from '../../src/proof/merkle.ts';
import type { SavannaChain } from '../../src/chains/savanna.ts';
import type { WithdrawalArtifact } from '../../src/savanna/withdrawalArtifact.ts';
import { bare, toHex } from '../../src/proof/hex.ts';
import type { LeafStore } from './leaves.ts';

export type LocalTree = {
  tree: IncrementalTree;
  /** Root as of `through`. */
  root: string;
  /** Checkpoint the replay started from. */
  from: number;
  through: number;
  /** Leaves appended from the local window. */
  replayed: number;
};

/**
 * A tree holding every leaf through `through`, built from local files only.
 *
 * `provingFrom` is the oldest block whose branch the caller will ask for, and it
 * decides where the replay starts — strictly before it, never on it. That is not
 * an off-by-one: a tree rebuilt from a frontier holds the peaks and no interior
 * nodes, so it can only emit a branch for a leaf it appended ITSELF. A leaf that
 * was already inside the frontier is unreachable, and the walk fails with "leaf
 * is not under root" rather than with anything that names the cause.
 *
 * Everything older than the start still works as a sibling: the walk descends
 * only through nodes formed during the replay, and the frontier's peaks are used
 * as values on the way past.
 */
export function treeThrough(
  checkpointDir: string,
  leaves: LeafStore,
  through: number,
  provingFrom: number = through,
): LocalTree {
  const block = through;
  const start = newestCheckpointAtOrBefore(checkpointDir, provingFrom - 1);
  if (!start) {
    throw new Error(
      `no checkpoint before block ${provingFrom}; a branch cannot be built without one`,
    );
  }
  const from = start.frontier.last_block;
  if (from > block) throw new Error(`checkpoint ${from} is past ${block}`);

  const window = leaves.readRange(from + 1, block); // throws if the window fell short
  for (const leaf of window) start.tree.append(leaf);

  return {
    tree: start.tree,
    root: toHex(start.tree.root()),
    from,
    through: block,
    replayed: window.length,
  };
}

export type Rebranch = {
  treeSiblings: string[];
  treePath: string;
  finalityMroot: string;
};

/**
 * Point a frozen artifact's release proof at a root that is already trusted.
 *
 * The leaf itself is rebuilt from the artifact's own seven fields rather than
 * read back from the window — the artifact is the authority on what was burned.
 * What the window must still cover is the replay: from the last checkpoint
 * before the burn through to the target root's block. Once it no longer does,
 * this reports so and the caller falls back to the artifact's own root, which
 * costs more gas and always works.
 */
export function rebranch(
  chain: SavannaChain,
  checkpointDir: string,
  leaves: LeafStore,
  artifact: WithdrawalArtifact,
  target: { mroot: string; block: number },
): Rebranch {
  // Replay has to begin before the BURN, not merely before the target: the
  // burn's own leaf is the one whose branch is being rebuilt, so this tree must
  // have appended it.
  const local = treeThrough(checkpointDir, leaves, target.block, artifact.burnBlock);
  const trusted = bare(target.mroot).toLowerCase();
  if (local.root !== trusted) {
    throw new Error(
      `rebuilt root at block ${target.block} is ${local.root}, but the root trusted on the ` +
        `far side is ${trusted} — the local tree and that root disagree`,
    );
  }

  const r = artifact.release;
  const leaf = finalityLeafBytes(chain, {
    majorVersion: r.majorVersion,
    minorVersion: r.minorVersion,
    blockNum: r.blockNum,
    timestamp: r.timestamp,
    parentTimestamp: r.parentTimestamp,
    finalityDigest: r.finalityDigest,
    actionMroot: r.actionMroot,
  });

  const steps = local.tree.proof(leaf, local.root);
  const folded = toHex(foldProof(leaf, steps));
  if (folded !== local.root) {
    throw new Error(`re-branched proof folds to ${folded}, not ${local.root}`);
  }

  const branch = toSolidityBranch(steps);
  return {
    treeSiblings: branch.siblings,
    treePath: branch.path,
    finalityMroot: `0x${local.root}`,
  };
}
