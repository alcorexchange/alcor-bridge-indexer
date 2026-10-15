/**
 * SSZ merkle branch helpers — the off-chain twin of `verify_branch` in the
 * contract, used to check a branch before it is ever pushed on-chain.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { toHex, fromHex } from '../proof/hex.ts';

/** Fold a leaf up with its siblings, exactly like is_valid_merkle_branch. */
export function foldBranch(leaf: Uint8Array, siblings: Uint8Array[], index: number): Uint8Array {
  let node = leaf;
  let idx = index;
  for (const sib of siblings) {
    const buf = new Uint8Array(64);
    if (idx & 1) { buf.set(sib, 0); buf.set(node, 32); }
    else { buf.set(node, 0); buf.set(sib, 32); }
    node = sha256(buf);
    idx >>= 1;
  }
  return node;
}

export type Branch = { name: string; leaf: string; siblings: string[]; index: number; root: string };

/**
 * Build the branch the contract wants: a generalized index minus the subtree
 * offset is the path the fold consumes. Throws unless it folds to `root`, so a
 * wrong gindex or a fork that renumbered one is caught here and not on-chain.
 */
export function branchFor(
  name: string,
  leaf: Uint8Array,
  branchHex: string[],
  gindex: number,
  root: Uint8Array,
): Branch {
  const siblings = branchHex.map(fromHex);
  const index = gindex - 2 ** siblings.length;
  const folded = foldBranch(leaf, siblings, index);
  if (toHex(folded) !== toHex(root)) {
    throw new Error(`${name} branch does not fold to its root (gindex ${gindex}, depth ${siblings.length})`);
  }
  return { name, leaf: toHex(leaf), siblings: siblings.map(toHex), index, root: toHex(root) };
}
