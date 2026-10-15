/**
 * Reading the bridge's own actions out of a block's traces: only what the
 * bridge itself received counts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ABI, Serializer } from '@wharfkit/antelope';

import { readBridgeEvents } from '../services/indexer/bridgeActions.ts';
import type { ActionTrace } from '../src/savanna/traces.ts';

/** The fields `readBridgeEvents` reads, in the contract's own names. */
const abi = ABI.from({
  version: 'eosio::abi/1.2',
  structs: [
    {
      name: 'credit',
      base: '',
      fields: [
        { name: 'domain', type: 'uint64' },
        { name: 'ext_token', type: 'string' },
        { name: 'nonce', type: 'uint64' },
        { name: 'beneficiary', type: 'name' },
        { name: 'canonical', type: 'uint64' },
        { name: 'memo', type: 'string' },
      ],
    },
    { name: 'refund', base: '', fields: [{ name: 'id', type: 'uint64' }] },
    { name: 'claim', base: '', fields: [{ name: 'owner', type: 'name' }, { name: 'sym_code', type: 'symbol_code' }] },
  ],
  actions: ['credit', 'refund', 'claim'].map((name) => ({ name, type: name, ricardian_contract: '' })),
});

const BRIDGE = 'bridge.alcor';

function trace(name: string, data: object, trxId: string, receiver = BRIDGE, account = BRIDGE): ActionTrace {
  return {
    receiver,
    account,
    name,
    data: Serializer.encode({ object: data, type: name, abi }).hexString,
    trxId,
  } as ActionTrace;
}

test('events come from the bridge account only, with the transaction they rode in', () => {
  const credit = { domain: '1181148696416462999', ext_token: 'ABCD', nonce: 9, beneficiary: 'alice', canonical: 7, memo: '' };
  const traces = [
    trace('credit', credit, 'tx1'),
    trace('credit', credit, 'tx1', 'wrap.alcor'), // the inline notification
    trace('claim', { owner: 'bob', sym_code: 'USDC' }, 'tx2'),
    trace('refund', { id: 3 }, 'tx3'),
    trace('refund', { id: 4 }, 'tx4', BRIDGE, 'other.acct'), // somebody else's refund
  ];
  const events = readBridgeEvents(abi, BRIDGE, traces);
  assert.deepEqual(
    events.map((e) => e.kind),
    ['credit', 'claim', 'refund'],
  );
  const [first, claim, refund] = events as any[];
  assert.equal(first.trxId, 'tx1');
  assert.equal(first.domain, '1181148696416462999');
  assert.equal(first.extToken, 'abcd');
  assert.equal(first.nonce, 9);
  assert.equal(first.beneficiary, 'alice');
  assert.equal(first.canonical, 7n);
  assert.equal(claim.symbolCode, 'USDC');
  assert.equal(refund.id, 3);
  assert.equal(refund.trxId, 'tx3');
});

test('an action this build cannot decode is skipped, not fatal', () => {
  const traces = [
    { receiver: BRIDGE, account: BRIDGE, name: 'credit', data: 'ff', trxId: 'bad' } as ActionTrace,
    trace('refund', { id: 1 }, 'ok'),
  ];
  assert.deepEqual(readBridgeEvents(abi, BRIDGE, traces).map((e) => e.kind), ['refund']);
});
