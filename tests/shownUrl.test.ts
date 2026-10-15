/**
 * shownUrl: an endpoint named in an error without the API key in its path.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { shownUrl } from '../src/net/fetchJson.ts';

test('a key in the path is left out', () => {
  assert.equal(shownUrl('https://polygon-mainnet.g.alchemy.com/v2/AbCdEfGhIjKlMnOpQrStUvWx'), 'https://polygon-mainnet.g.alchemy.com/v2/…');
});

test('a hash and a short path stay', () => {
  const root = '0x' + 'ab'.repeat(32);
  assert.equal(shownUrl(`https://beacon.example/eth/v1/beacon/headers/${root}`), `https://beacon.example/eth/v1/beacon/headers/${root}`);
  assert.equal(shownUrl('https://bsc-rpc.publicnode.com'), 'https://bsc-rpc.publicnode.com');
});
