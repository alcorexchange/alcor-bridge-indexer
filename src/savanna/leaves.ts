/**
 * The rolling window of finality-tree leaf hashes, on disk.
 *
 * ## What it is for
 *
 * Exactly one thing: re-branching an old burn onto a root that Ethereum already
 * trusts. `AlcorWithdrawals` checks only `trustedRoots(finalityMroot)`, and that
 * mapping never clears, so a withdrawal can settle against any later root — at
 * 176k gas instead of the ~2.6M a self-contained artifact costs. What that needs
 * is a fresh tree branch, and a branch is made of leaves.
 *
 * The frozen artifact already carries the burn's own seven leaf fields, so only
 * the 32-byte hashes are kept here. Nothing else is derivable from them and
 * nothing else needs to be.
 *
 * ## Shape
 *
 * Fixed 32-byte records, chunked by block number, so the offset of a block is
 * arithmetic and there is no index to corrupt:
 *
 *   leaves/<chunk>.bin     chunk = floor((block - genesis) / CHUNK_LEAVES)
 *   offset within it       ((block - genesis) % CHUNK_LEAVES) * 32
 *
 * Pruning is deleting whole chunk files. That is safe for proving anything
 * newer, because a branch for leaf `i` is (the peaks at time `i`, which a
 * checkpoint holds) plus (the leaves after `i`, which are the ones kept).
 *
 * ## Appends are strictly sequential
 *
 * A gap cannot be patched later. The tree is a carry-propagating counter, so a
 * missing leaf does not leave a hole — it shifts every leaf after it into the
 * wrong position, and every root computed from them is merely different. So a
 * non-sequential append throws rather than seeking.
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';

export const LEAF_BYTES = 32;
/** Leaves per file: 32 MB a chunk, about six days of a half-second chain. */
export const CHUNK_LEAVES = 1_000_000;

const CHUNK_FILE = /^(\d+)\.bin$/;

export class LeafStore {
  readonly dir: string;
  /** Block whose leaf is index 0 — the chain's finality-tree genesis. */
  readonly genesis: number;
  private handles = new Map<number, number>();
  /** Chunks whose handle was opened read-only: a relayer beside the indexer reads a mounted copy it may not write. */
  private readOnly = new Set<number>();
  private last: number | undefined;
  private first: number | undefined;

  constructor(dir: string, genesisBlock: number) {
    this.dir = dir;
    this.genesis = genesisBlock;
    mkdirSync(dir, { recursive: true });
    this.scan();
  }

  /** Learn the extent from the files themselves; there is no side-car to trust. */
  private scan(): void {
    const chunks = readdirSync(this.dir)
      .map((n) => CHUNK_FILE.exec(n))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => Number(m[1]))
      .sort((a, b) => a - b);

    if (!chunks.length) {
      this.first = undefined;
      this.last = undefined;
      return;
    }
    const firstChunk = chunks[0];
    const lastChunk = chunks[chunks.length - 1];
    const filled = statSync(this.path(lastChunk)).size / LEAF_BYTES;
    this.last = this.genesis + lastChunk * CHUNK_LEAVES + filled - 1;
    this.first = this.firstWritten(firstChunk);
  }

  /**
   * The first block actually written in a chunk, not where the chunk begins.
   *
   * An instance that starts mid-chunk writes at an offset, and the file before
   * that offset is a sparse hole that reads back as zeros. Reporting the chunk's
   * start as the window's start would make `readRange` hand out those zeros as
   * leaves — a tree that builds cleanly, produces a root nobody agrees with, and
   * proves the wrong thing without an error anywhere.
   *
   * A leaf is a sha256 output, so all-zero is not a value one can take; the hole
   * is a prefix, and a binary search finds where it ends in a handful of reads.
   */
  private firstWritten(chunk: number): number {
    const path = this.path(chunk);
    const records = statSync(path).size / LEAF_BYTES;
    const fd = openSync(path, 'r');
    const isHole = (index: number): boolean => {
      const buf = Buffer.allocUnsafe(LEAF_BYTES);
      readSync(fd, buf, 0, LEAF_BYTES, index * LEAF_BYTES);
      return buf.every((b) => b === 0);
    };
    try {
      if (!isHole(0)) return this.genesis + chunk * CHUNK_LEAVES;
      let lo = 0;
      let hi = records - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (isHole(mid)) lo = mid + 1;
        else hi = mid;
      }
      return this.genesis + chunk * CHUNK_LEAVES + lo;
    } finally {
      closeSync(fd);
    }
  }

  private path = (chunk: number) => join(this.dir, `${chunk}.bin`);
  private chunkOf = (block: number) => Math.floor((block - this.genesis) / CHUNK_LEAVES);
  private offsetOf = (block: number) => ((block - this.genesis) % CHUNK_LEAVES) * LEAF_BYTES;

  private fd(chunk: number, forWriting: boolean): number {
    const open = this.handles.get(chunk);
    if (open !== undefined) {
      if (!forWriting || !this.readOnly.has(chunk)) return open;
      // Opened for reading earlier; a write needs the file writable.
      closeSync(open);
      this.handles.delete(chunk);
      this.readOnly.delete(chunk);
    }
    const path = this.path(chunk);
    if (!forWriting && !existsSync(path)) return -1;
    // A reader never asks for write access: the files may be a read-only mount.
    const fd = openSync(path, forWriting ? (existsSync(path) ? 'r+' : 'w+') : 'r');
    if (!forWriting) this.readOnly.add(chunk);
    this.handles.set(chunk, fd);
    return fd;
  }

  /** The newest block with a leaf here, or undefined when empty. */
  get lastBlock(): number | undefined {
    return this.last;
  }

  /** The oldest block still kept — anything before it was pruned. */
  get firstBlock(): number | undefined {
    return this.first;
  }

  get count(): number {
    return this.last === undefined ? 0 : this.last - this.first! + 1;
  }

  /**
   * Append one leaf. The block must be the one after the last appended.
   *
   * The exception is the very first append after a prune-to-empty or a fresh
   * start, which may begin anywhere: a window that starts late is a window, and
   * a window with a hole in it is a lie.
   */
  append(blockNum: number, leaf: Uint8Array): void {
    if (leaf.length !== LEAF_BYTES) {
      throw new Error(`leaf for block ${blockNum} is ${leaf.length} bytes, expected ${LEAF_BYTES}`);
    }
    if (this.last !== undefined && blockNum <= this.last) {
      // A restart resumes from the frontier, which is saved every few seconds
      // and is therefore behind the leaves. Re-appending what is already here is
      // normal; re-appending something DIFFERENT is a fork, and is not.
      const have = this.read(blockNum);
      if (have && Buffer.compare(have, leaf) === 0) return;
      throw new Error(
        `leaf for block ${blockNum} is already stored and differs — the stored tree and the ` +
          `chain disagree from here on`,
      );
    }
    if (this.last !== undefined && blockNum !== this.last + 1) {
      throw new Error(
        `leaf store is at block ${this.last} and was handed ${blockNum}. A gap cannot be ` +
          `patched: every later leaf would sit at the wrong index and every root computed ` +
          `from them would be silently different.`,
      );
    }
    if (blockNum < this.genesis) {
      throw new Error(`block ${blockNum} predates the finality tree genesis ${this.genesis}`);
    }

    const chunk = this.chunkOf(blockNum);
    writeSync(this.fd(chunk, true), leaf, 0, LEAF_BYTES, this.offsetOf(blockNum));
    if (this.first === undefined) this.first = blockNum;
    this.last = blockNum;
  }

  /** One leaf, or undefined when it is outside the window. */
  read(blockNum: number): Uint8Array | undefined {
    if (this.last === undefined || blockNum < this.first! || blockNum > this.last) return undefined;
    const fd = this.fd(this.chunkOf(blockNum), false);
    if (fd < 0) return undefined;
    const out = Buffer.allocUnsafe(LEAF_BYTES);
    const got = readSync(fd, out, 0, LEAF_BYTES, this.offsetOf(blockNum));
    return got === LEAF_BYTES ? new Uint8Array(out) : undefined;
  }

  /**
   * A contiguous run, for replaying a tree forward from a checkpoint.
   *
   * Throws rather than returning a short array: a caller that silently gets
   * fewer leaves than it asked for builds a tree at the wrong height.
   */
  readRange(fromBlock: number, toBlock: number): Uint8Array[] {
    if (toBlock < fromBlock) return [];
    if (this.last === undefined || fromBlock < this.first! || toBlock > this.last) {
      throw new Error(
        `leaves ${fromBlock}..${toBlock} are not all in the window ` +
          `(${this.first ?? '-'}..${this.last ?? '-'})`,
      );
    }
    const out: Uint8Array[] = [];
    // Read whole chunks at a time: a few large reads instead of one per leaf.
    for (let block = fromBlock; block <= toBlock; ) {
      const chunk = this.chunkOf(block);
      const chunkEnd = Math.min(toBlock, this.genesis + (chunk + 1) * CHUNK_LEAVES - 1);
      const start = this.offsetOf(block);
      const bytes = (chunkEnd - block + 1) * LEAF_BYTES;
      const buf = Buffer.allocUnsafe(bytes);
      const fd = this.fd(chunk, false);
      if (fd < 0) throw new Error(`leaf chunk ${chunk} is missing`);
      const got = readSync(fd, buf, 0, bytes, start);
      if (got !== bytes) throw new Error(`leaf chunk ${chunk} is short by ${bytes - got} bytes`);
      for (let i = 0; i < chunkEnd - block + 1; i++) {
        out.push(new Uint8Array(buf.subarray(i * LEAF_BYTES, (i + 1) * LEAF_BYTES)));
      }
      block = chunkEnd + 1;
    }
    return out;
  }

  /**
   * Drop whole chunks that end before `keepFrom`.
   *
   * Whole chunks only: a partially emptied file would make `firstBlock` a lie
   * about what can be read. Returns how many leaves went.
   */
  prune(keepFrom: number): number {
    // The last line of defence, because this deletes files: a non-finite
    // boundary makes `chunkLast >= keepFrom` false for every chunk, and the loop
    // below then removes all of them.
    if (!Number.isFinite(keepFrom)) {
      throw new Error(`refusing to prune leaves before ${keepFrom}: not a block number`);
    }
    if (this.last === undefined) return 0;
    let dropped = 0;
    for (const name of readdirSync(this.dir)) {
      const m = CHUNK_FILE.exec(name);
      if (!m) continue;
      const chunk = Number(m[1]);
      const chunkLast = this.genesis + (chunk + 1) * CHUNK_LEAVES - 1;
      if (chunkLast >= keepFrom) continue;
      const open = this.handles.get(chunk);
      if (open !== undefined) {
        closeSync(open);
        this.handles.delete(chunk);
        this.readOnly.delete(chunk);
      }
      dropped += statSync(join(this.dir, name)).size / LEAF_BYTES;
      unlinkSync(join(this.dir, name));
    }
    if (dropped) this.scan();
    return dropped;
  }

  bytes(): number {
    return readdirSync(this.dir)
      .filter((n) => CHUNK_FILE.test(n))
      .reduce((sum, n) => sum + statSync(join(this.dir, n)).size, 0);
  }

  close(): void {
    for (const fd of this.handles.values()) closeSync(fd);
    this.handles.clear();
    this.readOnly.clear();
  }
}

/**
 * Make the window continue a tree whose last leaf is `frontierLast`, or empty it.
 *
 * The leaves are written per block and the frontier every few seconds, so after
 * a crash the window runs past the frontier, and the caller replays the
 * difference. Two shapes cannot be continued: a window that ends before the
 * frontier, and one that begins after it — the leaves between would be missing,
 * and a window with a hole in it reads as zeros and proves nothing. Either is
 * dropped whole rather than carried, and what was dropped is returned so the
 * caller can say so loudly: it costs the cheap settlement track for a while.
 */
export function alignLeaves(
  leaves: LeafStore,
  frontierLast: number,
): { window: string; dropped: number } | undefined {
  const first = leaves.firstBlock;
  const last = leaves.lastBlock;
  if (first === undefined || last === undefined) return undefined;
  if (last >= frontierLast && first <= frontierLast + 1) return undefined;
  const dropped = leaves.count;
  leaves.prune(Number.MAX_SAFE_INTEGER);
  return { window: `${first}..${last}`, dropped };
}
