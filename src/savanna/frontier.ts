/**
 * Reading, writing and checkpointing the finality tree frontier.
 *
 * A frontier is the whole persistent state of the tree: the tops of the complete
 * subtrees the leaf count decomposes into, which is `popcount(leaves)` hashes —
 * fourteen at 8.3 million leaves, and never more than sixty-four. Everything
 * beneath them is derivable and is not kept.
 *
 * What a frontier does NOT carry is any way to build a merkle branch. It is a
 * cursor for appending, not an index: the siblings a proof needs are interior
 * nodes, and those exist only in a tree instance that appended the leaves under
 * them. So proving a withdrawal in block X means replaying from a frontier at or
 * before X — which is cheap if a checkpoint sits nearby and expensive if the only
 * one is the genesis seed.
 *
 * Hence checkpoints. They cost `popcount` hashes each and turn an hours-long cold
 * replay into seconds.
 */

import { readFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { treeFromFrontier } from './tree.ts';
import type { IncrementalTree } from '../proof/merkle.ts';
import { bare, toHex } from '../proof/hex.ts';
import { writeJsonAtomic } from '../files.ts';

export type Frontier = {
  /** Leaves in the tree, counted from the Savanna transition block. */
  leaves: number;
  /** The block whose leaf was appended last. */
  last_block: number;
  root: string;
  active_nodes: string[];
  /** Roots checked against a block header while building, and how many differed. */
  checked?: number;
  mismatches?: number;
  /**
   * Finalizer policies known when the checkpoint was taken.
   *
   * Without these a checkpoint is only half a starting point: the tree would
   * resume correctly and the first block no certificate claims would still be
   * uncomputable, because its digest needs the policy that was pending at the
   * time and the chain publishes that only at a transition.
   */
  policies?: { generation: number; digest: string; startSlot: number }[];
  /**
   * The same policies in full — keys and weights — packed as the chain packs
   * them, so `sha256(packed)` is the digest above.
   *
   * The digest is enough to compute a digest; it is not enough to check a
   * certificate, which needs the keys. Those are published once, on the block
   * that made the policy pending, and a checkpoint taken after state-history has
   * pruned that block has no other way to them: `get_finalizer_info` only serves
   * the generation active now.
   */
  finalizer_policies?: { generation: number; packed: string }[];
};

/** The frontier a live tree currently describes. */
export function frontierOf(
  tree: IncrementalTree,
  lastBlock: number,
  leaves: number,
  policies?: { generation: number; digest: string; startSlot: number }[],
  finalizerPolicies?: { generation: number; packed: string }[],
): Frontier {
  return {
    leaves,
    last_block: lastBlock,
    root: toHex(tree.root()),
    active_nodes: tree.trees.map(toHex),
    ...(policies?.length ? { policies } : {}),
    ...(finalizerPolicies?.length ? { finalizer_policies: finalizerPolicies } : {}),
  };
}

/**
 * Load a frontier and rebuild the tree it describes.
 *
 * The root is recomputed and compared rather than trusted: a frontier is a
 * handful of hashes with no internal redundancy, so a truncated or edited file
 * looks perfectly well-formed and yields a tree that silently proves nothing.
 *
 * A frontier that recorded a mismatch is refused outright. It is a complete
 * description of a tree — including a wrong one — and every root after the
 * divergence inherits it.
 */
export function readFrontier(path: string): { frontier: Frontier; tree: IncrementalTree } {
  const frontier: Frontier = JSON.parse(readFileSync(path, 'utf8'));
  const mismatches = frontier.mismatches ?? 0;
  if (typeof mismatches !== 'number') {
    throw new Error(
      `${path}: "mismatches" is a count of roots the chain disagreed with, but this file ` +
        `holds ${JSON.stringify(mismatches)}. Refusing to guess whether that means none.`,
    );
  }
  if (mismatches > 0) {
    throw new Error(
      `${path} recorded ${mismatches} mismatch(es) against the chain, so its ` +
        `frontier describes a tree the chain does not agree with`,
    );
  }
  const tree = treeFromFrontier(frontier.leaves, frontier.active_nodes);
  if (toHex(tree.root()) !== bare(frontier.root).toLowerCase()) {
    throw new Error(`${path}: the frontier does not reproduce its own root`);
  }
  return { frontier, tree };
}

/** Write a frontier atomically, so a killed run never leaves half of one. */
export function writeFrontier(path: string, f: Frontier): void {
  writeJsonAtomic(path, f);
}

const CHECKPOINT = /^(\d+)\.json$/;

/** `<dir>/<last_block>.json`, created if the directory does not exist. */
export function saveCheckpoint(dir: string, f: Frontier): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${f.last_block}.json`);
  writeFrontier(path, f);
  return path;
}

/**
 * The newest checkpoint no later than `block`, or undefined if there is none.
 *
 * "No later than" matters: replaying forward from a frontier is the only
 * direction that works, so a checkpoint past the target is useless however close.
 */
export function newestCheckpointAtOrBefore(
  dir: string,
  block: number,
): { path: string; frontier: Frontier; tree: IncrementalTree } | undefined {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return undefined; // no checkpoints taken yet
  }

  const best = names
    .map((n) => CHECKPOINT.exec(n))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => Number(m[1]))
    .filter((n) => n <= block)
    .sort((a, b) => b - a)[0];

  if (best === undefined) return undefined;
  const path = join(dir, `${best}.json`);
  return { path, ...readFrontier(path) };
}
