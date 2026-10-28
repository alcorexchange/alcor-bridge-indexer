/**
 * The fast path's wait (eta.ts): confirmations and the push, said only where it
 * is quicker than finality.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { depositEta, depositFastEta } from '../src/chains/eta.ts';
import { EVM_CHAINS } from '../src/chains/evm.ts';

const ethereum = EVM_CHAINS.mainnet!;

test('twelve Ethereum confirmations and the push: about three minutes, as measured', () => {
  const fast = depositFastEta(ethereum, 12);
  assert.ok(fast);
  assert.equal(fast.seconds, 12 * 12 + 30);
  assert.ok(fast.seconds < depositEta(ethereum).seconds);
  assert.equal(fast.parts[0]!.what, '12 Ethereum confirmations');
});

test('no fast path: no wait to say', () => {
  assert.equal(depositFastEta(ethereum, 0), null);
});

test('a fast path no quicker than finality is not said', () => {
  const bsc = EVM_CHAINS.bsc!;
  assert.equal(depositFastEta(bsc, 100), null);
});
