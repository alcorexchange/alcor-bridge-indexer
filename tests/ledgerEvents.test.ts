/**
 * A block's withdrawals and bridge events, and the rows they leave: which
 * `wdlog` is which, which can be proved on an EVM chain, and what each step of
 * a crossing writes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { antelopeBurns, antelopeWdlog, type BridgeEvent } from '../services/indexer/bridgeActions.ts';
import { applyBridgeEvents } from '../services/indexer/ledgerEvents.ts';
import { Store, depositKey, withdrawalKey } from '../services/indexer/db.ts';
import { blockWdlogs, decodeWdlog } from '../src/savanna/withdrawalProof.ts';
import { nameToUint64 } from '../src/proof/pack.ts';
import type { ActionTrace } from '../src/savanna/traces.ts';

const BRIDGE = 'bridge.alcor';
const WAX = 1181148696416462999n;

/** id 8, domain 8, vault 1+8, token 1+16, recipient 1+8, amount 8, deadline 8, fee 8, memo. */
function antelopePayload(fields: { id: bigint; domain: bigint; recipient: string; amount: bigint; deadline: bigint }): string {
  const b = Buffer.alloc(75);
  b.writeBigUInt64LE(fields.id, 0);
  b.writeBigUInt64LE(fields.domain, 8);
  b[16] = 8;
  b.writeBigUInt64LE(nameToUint64('bridge.alcor'), 17);
  b[25] = 16;
  b.writeBigUInt64LE(nameToUint64('wrap.alcor'), 26);
  b[34] = 6;
  b.write('USDC', 35, 'ascii');
  b[42] = 8;
  b.writeBigUInt64LE(nameToUint64(fields.recipient), 43);
  b.writeBigUInt64LE(fields.amount, 51);
  b.writeBigUInt64LE(fields.deadline, 59);
  return b.toString('hex');
}

/** id 8, domain 8, three 1+20 addresses, amount 8, deadline 8, fee 8, an empty memo. */
function evmPayload(id: bigint, domain: bigint): string {
  const b = Buffer.alloc(8 + 8 + 21 * 3 + 24 + 1);
  b.writeBigUInt64LE(id, 0);
  b.writeBigUInt64LE(domain, 8);
  for (const at of [16, 37, 58]) {
    b[at] = 0x14;
    b.fill(at, at + 1, at + 21);
  }
  b.writeBigUInt64LE(5n, 79);
  b.writeBigUInt64LE(1790000000n, 87);
  return b.toString('hex');
}

let sequence = 100n;
function trace(name: string, data: string, trxId: string, account = BRIDGE): ActionTrace {
  sequence++;
  return {
    receiver: account,
    account,
    name,
    data,
    trxId,
    receipt: {
      receiver: account, actDigest: '', globalSequence: sequence, recvSequence: sequence,
      authSequence: [], codeSequence: 0, abiSequence: 0,
    },
  };
}

test('antelopeWdlog reads the Antelope shape and refuses any other', () => {
  const w = antelopeWdlog(antelopePayload({ id: 12n, domain: WAX, recipient: 'alice.wam', amount: 1_000_000n, deadline: 1790000000n }))!;
  assert.equal(w.id, 12n);
  assert.equal(w.domain, WAX);
  assert.equal(w.recipient, 'alice.wam');
  assert.equal(w.amount, 1_000_000n);
  assert.equal(w.deadline, 1790000000n);
  assert.equal(w.token.length, 32);

  assert.equal(antelopeWdlog(evmPayload(1n, 1n)), undefined);
  assert.equal(antelopeWdlog('00'.repeat(40)), undefined);
});

test('a block with WAX and EVM burns: one ordinal count, and only the EVM ones are provable there', () => {
  const traces = [
    trace('transfer', '00', 'tx0', 'eosio.token'),
    trace('wdlog', evmPayload(41n, 56n), 'tx1'),
    trace('wdlog', antelopePayload({ id: 42n, domain: WAX, recipient: 'bob.wam', amount: 7n, deadline: 1n }), 'tx2'),
    trace('wdlog', evmPayload(43n, 1n), 'tx3'),
    trace('wdlog', evmPayload(99n, 1n), 'tx4', 'other.acct'), // somebody else's wdlog
  ];
  // Delivered out of order: the count follows execution, not arrival.
  const wdlogs = blockWdlogs([...traces].reverse(), BRIDGE);
  assert.deepEqual(
    wdlogs.map((w) => [w.ordinal, w.index, w.id, w.frozen, w.trxId]),
    [
      [0, 1, 41n, true, 'tx1'],
      [1, 2, 42n, false, 'tx2'],
      [2, 3, 43n, true, 'tx3'],
    ],
  );
  // Every EVM one decodes as a proof payload; the WAX one would throw, which is
  // what used to abort a whole block and leave withdrawal 43 unfrozen.
  for (const w of wdlogs.filter((x) => x.evm)) assert.equal(decodeWdlog(w.data).id, w.id);
  assert.throws(() => decodeWdlog(wdlogs[1].data), /^Error: wdlog/);
  // A replay for withdrawal 43 proves ordinal 2 and nothing else.
  assert.equal(wdlogs.find((w) => w.id === 43n)!.ordinal, 2);

  const burns = antelopeBurns(wdlogs);
  assert.deepEqual(burns.map((b) => b.kind === 'burn' && [b.id, b.recipient, b.trxId]), [[42n, 'bob.wam', 'tx2']]);
});

test('applyBridgeEvents: each step of a crossing writes its row', () => {
  const store = new Store(':memory:');
  const block = 500;
  const at = 1_790_000_000;
  // A deposit whose source side was already read.
  store.upsertTransfer({ key: depositKey(56, 2), direction: 'deposit', ref: 2, status: 'seen', domain: '56', src_block: 77, src_time: 1000, src_tx: '0xsrc' });

  const events: BridgeEvent[] = [
    ...antelopeBurns(blockWdlogs([trace('wdlog', antelopePayload({ id: 7n, domain: WAX, recipient: 'carol.wam', amount: 9n, deadline: 1790000500n }), 'tb')], BRIDGE)),
    { kind: 'credit', domain: '56', nonce: 2, beneficiary: 'alice', canonical: 1000n, memo: '', extToken: 'AABB', trxId: 'tc' },
    { kind: 'credit', domain: '1', nonce: 3, beneficiary: 'hop.alcor', canonical: 5n, memo: 'x', extToken: 'cc', trxId: 'td' },
    { kind: 'forward', domain: '1', nonce: 3, trxId: 'td' },
    { kind: 'bounce', domain: '1', nonce: 4, trxId: 'te' },
    { kind: 'refund', id: 8, trxId: 'tf' },
    { kind: 'claim', owner: 'alice', symbolCode: 'USDT', trxId: 'tg' },
    { kind: 'hop', id: 9, prev: 0, quantity: '5.0000 USDT', toDomain: String(WAX), to: 'dave.wam', backDomain: '1', back: '0xback', trxId: 'td' },
    { kind: 'hop', id: 10, prev: 9, quantity: '5.0000 USDT', toDomain: '1', to: '0xback', backDomain: '1', back: '0xback', trxId: 'th' },
  ];
  applyBridgeEvents(store, events, block, at);

  const burn = store.getTransfer(withdrawalKey(7))!;
  assert.deepEqual(
    [burn.status, burn.evm_address, burn.domain, burn.src_block, burn.src_time, burn.src_tx, burn.deadline],
    ['burned', 'carol.wam', String(WAX), block, at, 'tb', 1790000500],
  );

  const credited = store.getTransfer(depositKey(56, 2))!;
  assert.deepEqual(
    [credited.status, credited.account, credited.token, credited.amount, credited.dst_block, credited.dst_tx],
    ['credited', 'alice', '0xaabb', '1000', block, 'tc'],
  );
  // Where it started stays what the source side said.
  assert.deepEqual([credited.src_block, credited.src_time, credited.src_tx], [77, 1000, '0xsrc']);

  // Parked by its memo, then forwarded in the same transaction: placed at the
  // credit, with no source block yet.
  const forwarded = store.getTransfer(depositKey(1, 3))!;
  assert.deepEqual([forwarded.status, forwarded.src_block, forwarded.src_time, forwarded.dst_tx], ['forwarded', 0, at, 'td']);

  const bounced = store.getTransfer(depositKey(1, 4))!;
  assert.deepEqual([bounced.status, bounced.dst_tx], ['bounced', 'te']);

  const refunded = store.getTransfer(withdrawalKey(8))!;
  assert.deepEqual([refunded.status, refunded.refund_tx, refunded.src_time], ['refunded', 'tf', at]);

  assert.deepEqual(store.claimsOf('alice').map((c) => ({ ...c })), [{ trx_id: 'tg', symbol: 'USDT', block, at }]);

  // A hop carries the deposit forwarded in its own transaction; a way back carries none.
  assert.equal(store.getHop(9)!.deposit, depositKey(1, 3));
  assert.deepEqual([store.getHop(10)!.deposit, store.getHop(10)!.prev], [null, 9]);
});
