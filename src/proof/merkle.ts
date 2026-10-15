/**
 * Wire's incremental merkle tree, and proofs against it.
 *
 * The tree keeps one perfect sub-tree per set bit of the leaf count — append
 * 11 leaves and you hold sub-trees of 8, 2 and 1. Sub-roots never change once
 * built, which is what makes old proofs stay valid as the chain grows. The root
 * folds the sub-trees right to left, largest first:
 *
 *   root = H(T0, H(T1, H(T2, … H(Tn-2, Tn-1))))
 *
 * `hash_combine` is plain sha256(a ‖ b) — a std::pair of digests packs as 64
 * bytes with no length prefixes.
 */
import { sha256 } from '@noble/hashes/sha2.js';

export const combine = (a: Uint8Array, b: Uint8Array): Uint8Array => {
  const buf = new Uint8Array(64);
  buf.set(a, 0);
  buf.set(b, 32);
  return sha256(buf);
};

/** Root of a perfect (power-of-two) sub-tree. */
function perfectRoot(leaves: Uint8Array[]): Uint8Array {
  let level = leaves;
  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(combine(level[i], level[i + 1]));
    level = next;
  }
  return level[0];
}

/** The sub-tree sizes for `n` leaves, largest first — the set bits of n. */
export function subtreeSizes(n: number): number[] {
  const sizes: number[] = [];
  for (let bit = 63; bit >= 0; bit--) {
    const size = 2 ** bit;
    if (n & size) sizes.push(size);
  }
  return sizes;
}

export function treeRoot(leaves: Uint8Array[]): Uint8Array {
  if (leaves.length === 0) throw new Error('empty tree has no root');
  const roots: Uint8Array[] = [];
  let at = 0;
  for (const size of subtreeSizes(leaves.length)) {
    roots.push(perfectRoot(leaves.slice(at, at + size)));
    at += size;
  }
  // Fold right to left: the smallest sub-tree ends up deepest.
  return roots.reduceRight((acc, r) => (acc === null ? r : combine(r, acc)), null as unknown as Uint8Array);
}

/**
 * A proof step: the sibling to hash with, and which side we are on.
 * `left: true` means our running node goes on the left.
 */
export type Step = { sibling: string; left: boolean };

/**
 * Merkle path for leaf `index` against the root of `leaves`.
 *
 * Two parts: the path inside our own sub-tree, then the folding of the
 * sub-trees. Everything to our right collapses into one sibling; everything to
 * our left is one sibling per sub-tree, applied outward.
 */
export function treeProof(leaves: Uint8Array[], index: number): Step[] {
  if (index < 0 || index >= leaves.length) throw new Error(`leaf ${index} out of range`);
  const sizes = subtreeSizes(leaves.length);
  const toHexLocal = (b: Uint8Array) => Buffer.from(b).toString('hex');

  // Locate the sub-tree holding the leaf.
  let at = 0;
  let which = 0;
  while (at + sizes[which] <= index) { at += sizes[which]; which++; }
  const size = sizes[which];
  const localIndex = index - at;

  const steps: Step[] = [];

  // 1. Climb inside the sub-tree.
  let level = leaves.slice(at, at + size);
  let idx = localIndex;
  while (level.length > 1) {
    const siblingIdx = idx ^ 1;
    steps.push({ sibling: toHexLocal(level[siblingIdx]), left: (idx & 1) === 0 });
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(combine(level[i], level[i + 1]));
    level = next;
    idx >>= 1;
  }

  // Sub-tree roots, for the folding steps.
  const roots: Uint8Array[] = [];
  let cursor = 0;
  for (const s of sizes) { roots.push(perfectRoot(leaves.slice(cursor, cursor + s))); cursor += s; }

  // 2. Everything to the right folds into a single sibling, and we are its left.
  if (which < roots.length - 1) {
    let right = roots[roots.length - 1];
    for (let i = roots.length - 2; i > which; i--) right = combine(roots[i], right);
    steps.push({ sibling: toHexLocal(right), left: true });
  }

  // 3. Each sub-tree to the left wraps us in turn, nearest first.
  for (let i = which - 1; i >= 0; i--) {
    steps.push({ sibling: toHexLocal(roots[i]), left: false });
  }

  return steps;
}

/** Fold a proof back to a root — the check a verifier performs. */
export function foldProof(leaf: Uint8Array, steps: Step[]): Uint8Array {
  let node = leaf;
  for (const step of steps) {
    const sib = Uint8Array.from(Buffer.from(step.sibling, 'hex'));
    node = step.left ? combine(node, sib) : combine(sib, node);
  }
  return node;
}

/**
 * Wire's incremental tree as the chain maintains it: a list of perfect sub-tree
 * roots, largest first, one per set bit of the leaf count.
 *
 * Rebuilding from a snapshot is the only way to prove a block: the sub-tree
 * roots are in-memory chain state, absent from blocks and from finality data.
 * Appending mirrors `_append` in incremental_merkle.hpp — a new leaf merges with
 * every consecutive filled slot below it, exactly as binary carrying works.
 */
export class IncrementalTree {
  mask: number;
  trees: Uint8Array[];
  /** every node ever formed, so a branch can be reconstructed */
  private nodes = new Map<string, { left: string; right: string }>();

  constructor(mask: number, trees: Uint8Array[]) {
    this.mask = mask;
    this.trees = [...trees];
  }

  private remember(parent: Uint8Array, left: Uint8Array, right: Uint8Array): void {
    this.nodes.set(Buffer.from(parent).toString('hex'), {
      left: Buffer.from(left).toString('hex'),
      right: Buffer.from(right).toString('hex'),
    });
  }

  append(leaf: Uint8Array): void {
    let carry = leaf;
    let bit = 0;
    // While the slot at `bit` is occupied, merge with it and carry upward.
    while (this.mask & (1 << bit)) {
      const left = this.trees.pop()!;      // smallest sub-tree is last
      const merged = combine(left, carry);
      this.remember(merged, left, carry);
      carry = merged;
      this.mask &= ~(1 << bit);
      bit++;
    }
    this.trees.push(carry);
    this.mask |= 1 << bit;
  }

  /**
   * Drop every remembered interior node, keeping the frontier.
   *
   * The tree can still append and still compute roots — that is what the
   * frontier is — but it can no longer emit a branch for a leaf appended before
   * this call. Leaves appended afterwards are provable again immediately, since
   * their path is rebuilt from the merges that carry them.
   *
   * A catch-up never wants this. A process that runs for a year does: a root is
   * computed once per block and each one remembers a handful of nodes, so the
   * map grows without bound while nothing older than a block or two is ever
   * asked for.
   */
  forget(): void {
    this.nodes.clear();
  }

  root(): Uint8Array {
    let node = this.trees[this.trees.length - 1];
    for (let i = this.trees.length - 2; i >= 0; i--) {
      const merged = combine(this.trees[i], node);
      this.remember(merged, this.trees[i], node);
      node = merged;
    }
    return node;
  }

  /**
   * The path from `leaf` up to a root, using only nodes seen while appending.
   * Walks down from the root following whichever child contains the leaf —
   * cheap, because the tree is at most 64 deep.
   *
   * `from` names an earlier root instead of the current one. The tree keeps
   * every node it ever formed, so a root this instance once computed stays
   * walkable however far the chain has moved on — which is what lets an old
   * withdrawal be proved into a root that was already submitted, rather than
   * paying to submit its own.
   */
  proof(leaf: Uint8Array, from?: string): Step[] {
    const target = Buffer.from(leaf).toString('hex');
    const root = from ? from.replace(/^0x/, '').toLowerCase() : Buffer.from(this.root()).toString('hex');
    const path: Step[] = [];

    const walk = (node: string): boolean => {
      if (node === target) return true;
      const children = this.nodes.get(node);
      if (!children) return false;
      if (walk(children.left)) { path.push({ sibling: children.right, left: true }); return true; }
      if (walk(children.right)) { path.push({ sibling: children.left, left: false }); return true; }
      return false;
    };

    if (!walk(root)) throw new Error(`leaf is not under root ${root}`);
    return path;
  }
}
