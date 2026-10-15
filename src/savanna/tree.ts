/**
 * The finality tree: one leaf per block since the Savanna transition, and the
 * root that a block header commits to.
 *
 * The leaf, from Spring's own reflection:
 *
 *   FC_REFLECT(valid_t::finality_leaf_node_t,
 *     (major_version)(minor_version)(block_num)(timestamp)(parent_timestamp)
 *     (finality_digest)(action_mroot))
 *
 * Two traps in those seven fields:
 *
 *   * `timestamp` and `parent_timestamp` are `block_timestamp_type`, i.e. u32
 *     half-second slots since the chain's epoch — not unix seconds. The parent's
 *     is the previous block's, so a leaf cannot be built from one block alone.
 *   * `action_mroot` here is the **real** action merkle root, which lives in
 *     `finality_data.action_mroot`. The block header's field of that name was
 *     repurposed under Savanna to carry the finality tree root instead. Two
 *     fields, near-identical names, opposite meanings.
 *
 * The tree itself is Antelope's `incremental_merkle_tree`: a list of perfect
 * sub-tree roots, one per set bit of the leaf count, largest first. A block's
 * header commits to the root as of the block its QC claims — not as of itself.
 */

import { sha256 } from '@noble/hashes/sha2.js';

import { Writer, timestampToSlot, type SlotEpoch } from '../proof/pack.ts';
import { IncrementalTree } from '../proof/merkle.ts';
import { fromHex, toHex } from '../proof/hex.ts';

export type FinalityLeafFields = {
  majorVersion: number;
  minorVersion: number;
  blockNum: number;
  /** block_timestamp slot, or an ISO string to convert. */
  timestamp: number | string;
  parentTimestamp: number | string;
  finalityDigest: string;
  /** finality_data.action_mroot — NOT the header field of the same name. */
  actionMroot: string;
};

export function finalityLeafBytes(chain: SlotEpoch, f: FinalityLeafFields): Uint8Array {
  const slot = (v: number | string) => (typeof v === 'number' ? v : timestampToSlot(chain, v));
  const w = new Writer()
    .u32(f.majorVersion)
    .u32(f.minorVersion)
    .u32(f.blockNum)
    .u32(slot(f.timestamp))
    .u32(slot(f.parentTimestamp))
    .raw(fromHex(f.finalityDigest))
    .raw(fromHex(f.actionMroot));
  return sha256(w.done());
}

export function finalityLeaf(chain: SlotEpoch, f: FinalityLeafFields): string {
  return toHex(finalityLeafBytes(chain, f));
}

/**
 * Rebuild an incremental tree from a saved frontier.
 *
 * The frontier is the whole of the tree's state: the perfect sub-tree roots,
 * one per set bit of the leaf count. Nothing else is needed to compute the root
 * or to keep appending — which is what makes a saved frontier a usable anchor,
 * and why the leaf count doubles as the occupancy bitmask.
 *
 * The catch is that a tree seeded this way remembers no interior nodes, so it
 * can produce roots and accept new leaves but cannot yet emit a branch for a
 * leaf appended before the seed.
 */
export function treeFromFrontier(leafCount: number, activeNodes: string[]): IncrementalTree {
  const expected = popcount(leafCount);
  if (activeNodes.length !== expected) {
    throw new Error(
      `frontier has ${activeNodes.length} nodes but a count of ${leafCount} needs ${expected}`,
    );
  }
  return new IncrementalTree(leafCount, activeNodes.map(fromHex));
}

export function popcount(n: number): number {
  let c = 0;
  for (let v = n; v; v >>>= 1) c += v & 1;
  return c;
}

/** Which leaf index a block occupies, given where the tree's leaves begin. */
export function leafIndexOf(blockNum: number, finalityGenesisBlock: number): number {
  const i = blockNum - finalityGenesisBlock;
  if (i < 0) throw new Error(`block ${blockNum} predates the finality tree`);
  return i;
}
