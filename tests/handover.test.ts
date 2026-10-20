/**
 * Handover: the certified block of a rotation's window is the first whose own
 * claim reaches P — the one whose certificate makes the pending policy final.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { certifiedTransition } from '../src/savanna/handover.ts';
import type { ShipBlock } from '../src/savanna/ship.ts';

/** [block, claims, active, pending], as state-history served them. */
const blocks = (rows: [number, number, number, number][]): ShipBlock[] =>
  rows.map(([n, claims, active, pending]) => ({
    this_block: { block_num: n },
    finality_data: {
      latest_qc_claim_block_num: claims,
      active_finalizer_policy_generation: active,
      last_pending_finalizer_policy_generation: pending,
    },
  }) as unknown as ShipBlock);

const numbers = (r: ReturnType<typeof certifiedTransition>) =>
  r && [r.transition.this_block.block_num, r.carrier.this_block.block_num];

test('generation 195: P+1 skipped P, so P+2 and the block that claims it', () => {
  // Telos mainnet, 2026-10-17: 494430001 claimed 494429999, skipping P.
  const window = blocks([
    [494429999, 494429998, 194, 194],
    [494430000, 494429999, 194, 195],
    [494430001, 494429999, 194, 195],
    [494430002, 494430001, 194, 195],
    [494430003, 494430002, 195, 195],
    [494430004, 494430003, 195, 195],
  ]);
  assert.deepEqual(numbers(certifiedTransition(window, 494430000)), [494430002, 494430003]);
});

test('an ordinary rotation: P+1, which claims P', () => {
  const window = blocks([
    [100, 99, 7, 8],
    [101, 100, 7, 8],
    [102, 101, 8, 8],
  ]);
  assert.deepEqual(numbers(certifiedTransition(window, 100)), [101, 102]);
});

test('P itself is never the block, claimed or not: it cannot settle its own policy', () => {
  // 102 claims P, but no block of the window claims as far as P.
  const window = blocks([
    [100, 99, 7, 8],
    [101, 99, 7, 8],
    [102, 100, 8, 8],
  ]);
  assert.equal(certifiedTransition(window, 100), undefined);
});

test('a claim on a block where the policy is already active is not a handover', () => {
  // Neither P nor P+1 claimed: only P+2 is, and P+2 has left the window.
  const window = blocks([
    [100, 98, 7, 8],
    [101, 98, 7, 8],
    [102, 98, 8, 8],
    [103, 102, 8, 8],
  ]);
  assert.equal(certifiedTransition(window, 100), undefined);
});

test('a window block missing from the fetch is not filled in', () => {
  assert.equal(certifiedTransition(blocks([[101, 100, 7, 8]]), 100), undefined);
});
