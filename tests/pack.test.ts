/**
 * Name and symbol packing: the encodings the ledger keys everything by.
 *
 * A wrong entry in either table produces a valid string for a different
 * account, with no error anywhere — which is why the known values below are
 * ones read off live tables, not computed by the code under test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { hexToName, nameToUint64, uint64ToName } from '../src/proof/pack.ts';
import { symbolCodeRaw } from '../services/indexer/fast.ts';
import { antelopeToken } from '../services/indexer/chains.ts';
import { packFinalizerPolicy, unpackFinalizerPolicy } from '../src/savanna/policyDiff.ts';

test('nameToUint64 matches the chain for a well-known name', () => {
  assert.equal(nameToUint64('eosio'), 6138663577826885632n);
  assert.equal(nameToUint64(''), 0n);
});

test('names round-trip, including dots inside and a 13th character', () => {
  for (const name of ['eosio', 'bridge.alcor', 'wax.lc.alcor', 'a', 'z.1.z', 'abcdefghijklj', 'zzzzzzzzzzzz5']) {
    assert.equal(uint64ToName(nameToUint64(name)), name);
  }
});

test('nameToUint64 refuses what is not a name', () => {
  assert.throws(() => nameToUint64('Upper'), /invalid character/);
  assert.throws(() => nameToUint64('abcdefghijklmn'), /longer than 13/);
  assert.throws(() => nameToUint64('abcdefghijklm'), /13th character/);
});

test('hexToName reads the eight little-endian bytes a table stores', () => {
  // 6138663577826885632 = 0x5530EA0000000000, little-endian on the wire.
  assert.equal(hexToName('0000000000ea3055'), 'eosio');
  const packed = Buffer.alloc(8);
  packed.writeBigUInt64LE(nameToUint64('bridge.alcor'));
  assert.equal(hexToName(packed.toString('hex')), 'bridge.alcor');
  // Longer input is fine: an ext_token carries the symbol after the name.
  assert.equal(hexToName(packed.toString('hex') + '0655534443000000'), 'bridge.alcor');
  assert.throws(() => hexToName('abcd'), /not a packed name/);
});

test('symbolCodeRaw is symbol_code::raw(), checked against the live assets table', () => {
  assert.equal(symbolCodeRaw('8,ETH'), '4740165');
  assert.equal(symbolCodeRaw('4,ATUSD'), '293455877185');
  // Precision is not part of it.
  assert.equal(symbolCodeRaw('6,ETH'), symbolCodeRaw('8,ETH'));
});

test('antelopeToken unpacks (contract, precision, symbol) from an ext_token', () => {
  const b = Buffer.alloc(16);
  b.writeBigUInt64LE(nameToUint64('wrap.alcor'), 0);
  b[8] = 6;
  b.write('USDC', 9, 'ascii');
  assert.deepEqual(antelopeToken(b.toString('hex')), { contract: 'wrap.alcor', symbol: 'USDC', precision: 6 });
  // An EVM token is twenty bytes and is not one.
  assert.equal(antelopeToken('00'.repeat(20)), undefined);
});

test('a finalizer policy unpacks to what was packed, and refuses trailing bytes', () => {
  const policy = {
    generation: 158,
    threshold: 15n,
    finalizers: [
      { description: 'bp.any', weight: 1n, publicKey: new Uint8Array(96).fill(7) },
      { description: 'telosamigoss', weight: 1n, publicKey: new Uint8Array(96).fill(9) },
    ],
  };
  const packed = packFinalizerPolicy(policy);
  assert.deepEqual(unpackFinalizerPolicy(packed), policy);
  assert.throws(() => unpackFinalizerPolicy(new Uint8Array([...packed, 0])), /trailing bytes/);
});
