import { test } from 'node:test';
import assert from 'node:assert/strict';

import { minimumAlarms, unchecked } from '../services/indexer/minimums.ts';

const eth = (vaultMinDeposit: string, minDeposit = '10000') => ({
  id: 'mainnet', name: 'Ethereum', chainId: 1,
  routes: [{ kind: 'backing', symbol: 'ETH', precision: 8, minDeposit, minWithdrawal: minDeposit, vaultMinDeposit }],
});
const wax = (min: string) => ({
  id: 'wax', name: 'WAX',
  routes: [{ kind: 'spoke', symbol: 'ETH', precision: 8, minDeposit: min, minWithdrawal: min }],
});

test('floors in order: no alarm', () => {
  assert.deepEqual(minimumAlarms([eth('100000'), wax('100000')]), []);
  assert.deepEqual(minimumAlarms([eth('100000'), wax('10000')]), []);
});

test('a spoke paying out from more than the vault takes', () => {
  assert.deepEqual(minimumAlarms([eth('10000'), wax('100000')]), [
    "ETH: the Ethereum vault takes deposits from 0.0001 ETH, WAX pays out from 0.001 ETH: a deposit address's ETH between them cannot go on to WAX",
  ]);
});

test('the bridge crediting from more than its own vault takes', () => {
  assert.deepEqual(minimumAlarms([eth('10000', '100000')]), [
    'ETH: the Ethereum vault takes deposits from 0.0001 ETH, the bridge credits them from 0.001 ETH: a deposit between is refused at credit',
  ]);
});

test('only EVM vaults, and only the same asset', () => {
  const sui = { id: 'sui', name: 'Sui', routes: [{ kind: 'backing', symbol: 'ETH', precision: 8, minDeposit: '1', minWithdrawal: '1', vaultMinDeposit: '1' }] };
  const usdc = { id: 'xpr', name: 'XPR', routes: [{ kind: 'spoke', symbol: 'USDC', precision: 6, minDeposit: '9000000', minWithdrawal: '9000000' }] };
  assert.deepEqual(minimumAlarms([eth('100000'), wax('100000'), sui, usdc]), []);
  // A vault that takes none of it has no floor to keep.
  assert.deepEqual(minimumAlarms([{ ...eth('1'), routes: [{ ...eth('1').routes[0], vaultEnabled: false }] }, wax('100000')]), []);
  // An EVM route whose vault was not read has no floor to compare.
  assert.deepEqual(minimumAlarms([{ ...eth('1'), routes: [{ ...eth('1').routes[0], vaultMinDeposit: undefined }] }, wax('100000')]), []);
});

test('what was not read is reported, so a barrier can refuse it', () => {
  assert.deepEqual(unchecked([eth('100000'), wax('100000')], ['mainnet']), []);
  assert.deepEqual(unchecked([], []), ['no EVM chain in the listing']);
  // Only a healthy mainnet, where BSC was expected.
  assert.deepEqual(unchecked([eth('100000')], ['mainnet', 'bsc']), ['bsc: not in the listing']);
  assert.deepEqual(unchecked([eth('100000'), { id: 'wax', name: 'WAX', error: 'timeout' }], ['mainnet']), ['wax: the listing could not read it (timeout)']);
  assert.deepEqual(unchecked([eth('100000'), { id: 'wax', name: 'WAX', routes: [] }], ['mainnet']), ['wax: no routes listed']);
  const unread = { ...eth('1'), routes: [{ ...eth('1').routes[0], vaultMinDeposit: undefined }] };
  assert.deepEqual(unchecked([unread, wax('100000')], ['mainnet']), ['mainnet ETH: the vault\'s floor was not read']);
});

