/**
 * RAM: the relayers' accounts are configured as `<chain>:<account>` pairs, and a
 * malformed one is refused rather than skipped.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseRelayerAccounts } from '../services/indexer/ram.ts';

test('relayer accounts are read as chain and account pairs', () => {
  assert.deepEqual(parseRelayerAccounts(' telos:payer , xpr:relayer,'), [
    { chain: 'telos', account: 'payer' },
    { chain: 'xpr', account: 'relayer' },
  ]);
  assert.deepEqual(parseRelayerAccounts(''), []);
});

test('a pair with no account is an error, not a relayer nobody watches', () => {
  assert.throws(() => parseRelayerAccounts('telos:'), /not <chain>:<account>/);
  assert.throws(() => parseRelayerAccounts('relayer'), /not <chain>:<account>/);
});
