/**
 * Picking R and C for a burn by who claims whom, including the block the
 * finalizers never certified.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { locateRootBlocks } from '../src/savanna/withdrawalArtifact.ts';
import type { ShipBlock } from '../src/savanna/ship.ts';

/** A window from `[block, claims]` pairs; only the claim is read. */
const windowOf = (pairs: [number, number][]): ShipBlock[] =>
  pairs.map(
    ([block_num, claim]) =>
      ({ this_block: { block_num }, finality_data: { latest_qc_claim_block_num: claim } }) as unknown as ShipBlock,
  );

test('R is the block after the burn and C the one after that, as usual', () => {
  const window = windowOf([[99, 98], [100, 99], [101, 100], [102, 101], [103, 102]]);
  assert.deepEqual(locateRootBlocks(window, 100), { rBlock: 101, cBlock: 102 });
});

test('a first claimer nobody certifies gives way to the next one (Telos 494039093)', () => {
  const window = windowOf([
    [494039091, 494039090],
    [494039092, 494039091],
    [494039093, 494039092],
    [494039094, 494039092],
    [494039095, 494039094],
    [494039096, 494039095],
  ]);
  assert.deepEqual(locateRootBlocks(window, 494039092), { rBlock: 494039094, cBlock: 494039095 });
});

test('no claimer of the burn, or none of its claimers signed yet, throws', () => {
  assert.throws(() => locateRootBlocks(windowOf([[99, 98], [100, 99]]), 100), /carries a certificate claiming it/);
  assert.throws(() => locateRootBlocks(windowOf([[100, 99], [101, 100], [102, 100]]), 100), /unsigned so far/);
});
