/**
 * Handover: the certified block of a rotation's window is P when anything
 * claims P, else P+1 — as at generation 195, where nothing claimed P.
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

test('generation 195: nothing claims P, so P+1 and the block that claims it', () => {
  // Telos mainnet, 2026-10-17: 494430001 claimed 494429999, skipping P.
  const window = blocks([
    [494429999, 494429998, 194, 194],
    [494430000, 494429999, 194, 195],
    [494430001, 494429999, 194, 195],
    [494430002, 494430001, 194, 195],
    [494430003, 494430002, 195, 195],
    [494430004, 494430003, 195, 195],
  ]);
  assert.deepEqual(numbers(certifiedTransition(window, 494430000)), [494430001, 494430002]);
});

test('P claimed: P, as every rotation before 195', () => {
  const window = blocks([
    [100, 99, 7, 8],
    [101, 100, 7, 8],
    [102, 101, 8, 8],
  ]);
  assert.deepEqual(numbers(certifiedTransition(window, 100)), [100, 101]);
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
