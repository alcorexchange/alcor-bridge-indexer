/**
 * The leaf window: appends are sequential, a hole is never read as leaves, and
 * pruning drops whole chunks only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { LeafStore, LEAF_BYTES, alignLeaves } from '../src/savanna/leaves.ts';

const leaf = (n: number) => new Uint8Array(createHash('sha256').update(String(n)).digest());
const dir = () => mkdtempSync(join(tmpdir(), 'alcor-leaves-'));

test('appends in order, reads back, knows its extent', () => {
  const s = new LeafStore(dir(), 100);
  assert.equal(s.lastBlock, undefined);
  for (let n = 100; n < 110; n++) s.append(n, leaf(n));
  assert.equal(s.firstBlock, 100);
  assert.equal(s.lastBlock, 109);
  assert.equal(s.count, 10);
  assert.deepEqual(s.read(105), leaf(105));
  assert.equal(s.read(110), undefined);
  assert.equal(s.readRange(103, 106).length, 4);
  assert.equal(s.bytes(), 10 * LEAF_BYTES);
});

test('re-appending the same leaf is a no-op; a different one is a fork', () => {
  const s = new LeafStore(dir(), 1);
  s.append(1, leaf(1));
  s.append(2, leaf(2));
  s.append(2, leaf(2));
  assert.throws(() => s.append(2, leaf(3)), /differs/);
  assert.equal(s.lastBlock, 2);
});

test('a gap cannot be patched', () => {
  const s = new LeafStore(dir(), 1);
  s.append(1, leaf(1));
  assert.throws(() => s.append(3, leaf(3)), /gap cannot be patched/);
  assert.throws(() => s.append(2, new Uint8Array(31)), /expected 32/);
});

test('a window that starts mid-chunk reports where the leaves begin, not where the file does', () => {
  const d = dir();
  const s = new LeafStore(d, 100);
  for (let n = 105; n < 110; n++) s.append(n, leaf(n));
  s.close();
  const again = new LeafStore(d, 100);
  assert.equal(again.firstBlock, 105);
  assert.equal(again.lastBlock, 109);
  assert.throws(() => again.readRange(100, 109), /not all in the window/);
  assert.deepEqual(again.readRange(105, 109)[0], leaf(105));
});

test('prune drops whole chunks and refuses a boundary that is not a number', () => {
  const s = new LeafStore(dir(), 1);
  for (let n = 1; n <= 5; n++) s.append(n, leaf(n));
  assert.throws(() => s.prune(NaN), /refusing to prune/);
  assert.equal(s.prune(3), 0); // the chunk still ends after the boundary
  assert.equal(s.count, 5);
  assert.equal(s.prune(Number.MAX_SAFE_INTEGER), 5);
  assert.equal(s.count, 0);
  assert.equal(s.lastBlock, undefined);
  s.append(50, leaf(50)); // a window may begin anywhere after a prune-to-empty
  assert.equal(s.firstBlock, 50);
});

test('alignLeaves keeps a window that continues the frontier and drops one that cannot', () => {
  const window = (from: number, to: number) => {
    const s = new LeafStore(dir(), 1);
    for (let n = from; n <= to; n++) s.append(n, leaf(n));
    return s;
  };
  // Ahead of the frontier, as after a crash: kept, and the caller replays 21..30.
  const ahead = window(10, 30);
  assert.equal(alignLeaves(ahead, 20), undefined);
  assert.equal(ahead.readRange(21, 30).length, 10);
  // Starting right after it: kept.
  assert.equal(alignLeaves(window(21, 30), 20), undefined);
  // Starting past it: the leaves between are missing, and a replay would throw.
  const late = window(25, 30);
  assert.deepEqual(alignLeaves(late, 20), { window: '25..30', dropped: 6 });
  assert.equal(late.lastBlock, undefined);
  // Ending before it: a hole after the window.
  assert.deepEqual(alignLeaves(window(5, 15), 20), { window: '5..15', dropped: 11 });
  // Empty: nothing to do.
  assert.equal(alignLeaves(new LeafStore(dir(), 1), 20), undefined);
});
