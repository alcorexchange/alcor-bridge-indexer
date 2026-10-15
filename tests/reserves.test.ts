/**
 * Reserves: issued on Telos beside what backs it on each chain.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { complete, reserves } from '../services/indexer/reserves.ts';

const sources = [
  {
    id: 'mainnet',
    routes: [{ kind: 'backing' as const, symbol: 'ETH', precision: 8, available: '39656382', vaultHeld: '39862605' }],
  },
  {
    id: 'wax',
    kind: 'antelope' as const,
    routes: [
      { kind: 'backing' as const, symbol: 'WAX', precision: 8, available: '1700000000' },
      // A spoke's `available` is the room under its cap, never backing.
      { kind: 'spoke' as const, symbol: 'ETH', precision: 8, available: '1810363618', locked: '39636382' },
    ],
  },
];

test('the vault balance where it was read, Telos record otherwise, and mirrors apart', () => {
  const supplies: Record<string, string> = { ETH: '0.39656382 ETH' };
  assert.deepEqual(reserves(sources, (s) => supplies[s] ?? null), [
    {
      symbol: 'ETH',
      precision: 8,
      issued: '0.39656382',
      locked: [{ chain: 'mainnet', amount: '0.39862605', read: 'vault' }],
      lockedTotal: '0.39862605',
      mirrored: [{ chain: 'wax', amount: '0.39636382' }],
    },
    {
      symbol: 'WAX',
      precision: 8,
      issued: null,
      locked: [{ chain: 'wax', amount: '17', read: 'ledger' }],
      lockedTotal: '17',
      mirrored: [],
    },
  ]);
});

test('a supply in another precision is an error, not a misread', () => {
  assert.throws(() => reserves(sources, () => '0.396563821 ETH'));
});

test('a vault that was not read is listed as failed, and there is no total', () => {
  const unread = [
    {
      id: 'mainnet',
      routes: [{ kind: 'backing' as const, symbol: 'USDC', precision: 6, available: '5595341894', outflowError: 'fetch failed' }],
    },
    {
      // The whole chain failed; its routes still come from the ledger.
      id: 'polygon',
      error: 'no execution endpoint answered eth_blockNumber',
      routes: [{ kind: 'backing' as const, symbol: 'USDC', precision: 6, available: '351089000' }],
    },
    {
      id: 'bsc',
      routes: [{ kind: 'backing' as const, symbol: 'USDC', precision: 6, available: '119500000', vaultHeld: '119500000' }],
    },
  ];
  const out = reserves(unread, () => '6065.930894 USDC');
  assert.deepEqual(out, [
    {
      symbol: 'USDC',
      precision: 6,
      issued: '6065.930894',
      locked: [
        // Telos's record is not offered in place of an EVM vault: it equals `issued` by construction.
        { chain: 'mainnet', amount: null, read: 'failed', error: 'fetch failed' },
        { chain: 'polygon', amount: null, read: 'failed', error: 'no execution endpoint answered eth_blockNumber' },
        { chain: 'bsc', amount: '119.5', read: 'vault' },
      ],
      lockedTotal: null,
      mirrored: [],
    },
  ]);
  assert.equal(complete(out), false);
});

test('complete only when every supply and every vault was read', () => {
  const supplies: Record<string, string> = { ETH: '0.39656382 ETH', WAX: '17.00000000 WAX' };
  assert.equal(complete(reserves(sources, (s) => supplies[s] ?? null)), true);
  assert.equal(complete(reserves(sources, (s) => (s === 'ETH' ? supplies[s] : null))), false);
});
