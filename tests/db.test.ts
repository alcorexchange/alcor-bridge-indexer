/**
 * The store: what a rescan may and may not do to a row.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Store, depositKey, withdrawalKey, voidKey, evmDomain, externalToken, BOOKED } from '../services/indexer/db.ts';

const fresh = () => new Store(':memory:');

test('keys: deposits are scoped by chain, withdrawals and voids are not', () => {
  assert.equal(depositKey(1, 7), 'd:1:7');
  assert.equal(depositKey('1181148696416462999', '7'), 'd:1181148696416462999:7');
  assert.equal(withdrawalKey(7), 'w:7');
  assert.equal(voidKey('7'), 'v:7');
});

test('evmDomain: a chain id is a number, an Antelope domain is not', () => {
  assert.equal(evmDomain('1'), 1);
  assert.equal(evmDomain(11155111), 11155111);
  assert.equal(evmDomain('1181148696416462999'), undefined);
  assert.equal(evmDomain('x'), undefined);
});

test('a rescan never moves a transfer backwards', () => {
  const store = fresh();
  const key = withdrawalKey(1);
  const base = { key, direction: 'withdrawal' as const, ref: 1, src_block: 10, src_time: 100 };
  store.upsertTransfer({ ...base, status: 'burned', account: 'alice' });
  store.upsertTransfer({ ...base, status: 'released', dst_tx: '0xabc' });
  store.upsertTransfer({ ...base, status: 'burned' }); // the Antelope side, re-read
  const row = store.getTransfer(key)!;
  assert.equal(row.status, 'released');
  assert.equal(row.account, 'alice'); // what an earlier write knew is kept
  assert.equal(row.dst_tx, '0xabc');
});

test('an upsert keeps a field the new write does not carry', () => {
  const store = fresh();
  const key = depositKey(1, 3);
  store.upsertTransfer({ key, direction: 'deposit', ref: 3, status: 'seen', src_block: 5, src_time: 50, src_tx: '0x1', token: '0xt', amount: '9' });
  store.upsertTransfer({ key, direction: 'deposit', ref: 3, status: 'credited', src_block: 0, src_time: 50, dst_tx: 'telos' });
  const row = store.getTransfer(key)!;
  assert.equal(row.status, 'credited');
  assert.equal(row.src_tx, '0x1');
  assert.equal(row.token, '0xt');
  assert.equal(row.dst_tx, 'telos');
});

test('pendingDeposits: one chain, unbooked, with a source transaction and no proof', () => {
  const store = fresh();
  const seen = (domain: string, nonce: number, extra: Record<string, unknown> = {}) =>
    store.upsertTransfer({ key: depositKey(domain, nonce), direction: 'deposit', ref: nonce, status: 'seen', domain, src_block: nonce, src_time: 1, src_tx: '0x' + nonce, ...extra } as any);
  seen('1', 1);
  seen('1', 2);
  seen('56', 3);
  store.upsertTransfer({ key: depositKey('1', 4), direction: 'deposit', ref: 4, status: 'seen', src_block: 4, src_time: 1 }); // no src_tx
  store.putProof(depositKey('1', 2), 'deposit', '{}');
  for (const status of BOOKED) seen('1', 10 + BOOKED.indexOf(status), { status });

  assert.deepEqual(store.pendingDeposits('1').map((r) => r.ref), [1]);
  assert.deepEqual(store.pendingDeposits('56').map((r) => r.ref), [3]);
});

test('unfrozenWithdrawals lists open burns without an artifact, oldest first', () => {
  const store = fresh();
  const burn = (id: number, at: number, status: any = 'burned') =>
    store.upsertTransfer({ key: withdrawalKey(id), direction: 'withdrawal', ref: id, status, src_block: id, src_time: at });
  burn(1, 30);
  burn(2, 10);
  burn(3, 20);
  burn(4, 5, 'released');
  store.putProof(withdrawalKey(3), 'withdrawal', '{}');
  assert.deepEqual(store.unfrozenWithdrawals().map((r) => r.ref), [2, 1]);
});

test('roots are trusted per chain, and a root seen again without a block keeps the one it has', () => {
  const store = fresh();
  store.putRoot('0xAB', 7, null, 100, 1);
  assert.deepEqual(store.rootsWithoutBlock().map((r) => r.mroot), ['0xab']);
  store.putRoot('0xab', 7, 50, 0, 1);
  store.putRoot('0xab', 7, null, 100, 1); // the follower rescanning the event
  assert.deepEqual(store.rootsWithoutBlock(), []);
  assert.deepEqual({ ...store.earliestRootCovering(40, 1) }, { mroot: '0xab', block: 50 });
  assert.equal(store.earliestRootCovering(40, 56), undefined);
  assert.equal(store.earliestRootCovering(51, 1), undefined);
});

test('incidents keep the tail only', () => {
  const store = fresh();
  for (let i = 0; i < 1010; i++) store.incident('t', String(i));
  const n = (store.db.prepare('SELECT COUNT(*) AS n FROM incidents').get() as { n: number }).n;
  assert.equal(n, 1000);
  assert.equal(store.recentIncidents(1)[0].detail, '1009');
});

test('externalToken: an EVM address carries 0x, an Antelope token stays bare', () => {
  assert.equal(externalToken('1', 'A0B86991C6218B36C1D19D4A2E9EB0CE3606EB48'), '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');
  assert.equal(externalToken(1, '0xA0B86991C6218B36C1D19D4A2E9EB0CE3606EB48'), '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');
  assert.equal(externalToken('1181148696416462999', '00A6823403EA30550857415800000000'), '00a6823403ea30550857415800000000');
});

test('pendingDeposits finds a chain\'s deposits whether its domain is asked as a number or text', () => {
  const store = fresh();
  store.upsertTransfer({
    key: depositKey(1, 3), direction: 'deposit', ref: 3, status: 'seen', domain: '1',
    src_block: 100, src_time: 1000, src_tx: '0xabc',
  });
  assert.deepEqual(store.pendingDeposits(1).map((r) => r.key), ['d:1:3']);
  assert.deepEqual(store.pendingDeposits('1').map((r) => r.key), ['d:1:3']);
  assert.deepEqual(store.pendingDeposits(56), []);
});

test('only an EVM-bound withdrawal can be missing its artifact', () => {
  const store = fresh();
  for (const [ref, domain] of [[1, '1'], [2, '1181148696416462999']] as const) {
    store.upsertTransfer({
      key: withdrawalKey(ref), direction: 'withdrawal', ref, status: 'burned', domain, src_block: 10, src_time: 100,
    });
  }
  assert.deepEqual(store.unfrozenWithdrawals().map((t) => t.key), ['w:1']);
});

test('firstSeen places a new row and never moves an existing one', () => {
  const store = fresh();
  const key = depositKey(1, 20);
  // A later step seen first: the row starts where it was seen.
  store.upsertTransfer({ key, direction: 'deposit', ref: 20, status: 'credited', firstSeen: { block: 0, time: 900 } });
  assert.equal(store.getTransfer(key)!.src_time, 900);
  // The source side, read afterwards, says where it really started.
  store.upsertTransfer({ key, direction: 'deposit', ref: 20, status: 'seen', src_block: 7, src_time: 800 });
  // Another later step: its firstSeen changes nothing now.
  store.upsertTransfer({ key, direction: 'deposit', ref: 20, status: 'forwarded', firstSeen: { block: 0, time: 1000 } });
  const row = store.getTransfer(key)!;
  assert.equal(row.src_block, 7);
  assert.equal(row.src_time, 800);
  assert.equal(row.status, 'forwarded');
});

test('a write that creates a row without saying where it started is refused', () => {
  const store = fresh();
  assert.throws(
    () => store.upsertTransfer({ key: withdrawalKey(30), direction: 'withdrawal', ref: 30, status: 'released' }),
    /new transfer/,
  );
  assert.equal(store.getTransfer(withdrawalKey(30)), undefined);
});

test('openWithdrawals: one domain, burned or provable, however many rows there are', () => {
  const store = fresh();
  const burn = (id: number, domain: string, status: any, at: number) =>
    store.upsertTransfer({ key: withdrawalKey(id), direction: 'withdrawal', ref: id, status, domain, src_block: id, src_time: at });
  // The oldest open one sits behind 250 newer settled rows: a "newest 200"
  // window never reached it.
  burn(1, '56', 'burned', 1);
  for (let id = 2; id < 252; id++) burn(id, '56', 'released', 100 + id);
  burn(300, '56', 'provable', 50);
  burn(301, '1', 'burned', 60); // another chain's
  burn(302, '1181148696416462999', 'burned', 70);
  assert.deepEqual(store.openWithdrawals(56).map((r) => r.ref), [1, 300]);
  assert.deepEqual(store.openWithdrawals('1').map((r) => r.ref), [301]);
});

test('dropSpentDepositProofs removes the proofs of booked deposits only', () => {
  const store = fresh();
  const deposit = (nonce: number, status: any) => {
    store.upsertTransfer({ key: depositKey(1, nonce), direction: 'deposit', ref: nonce, status, domain: '1', src_block: nonce, src_time: 1 });
    store.putProof(depositKey(1, nonce), 'deposit', '{}');
  };
  deposit(1, 'provable');
  BOOKED.forEach((status, i) => deposit(10 + i, status));
  store.upsertTransfer({ key: withdrawalKey(5), direction: 'withdrawal', ref: 5, status: 'released', src_block: 1, src_time: 1 });
  store.putProof(withdrawalKey(5), 'withdrawal', '{}');
  store.putProof(voidKey(5), 'void', '{}');

  assert.equal(store.dropSpentDepositProofs(), BOOKED.length);
  assert.ok(store.hasProof(depositKey(1, 1)));
  assert.ok(store.hasProof(withdrawalKey(5)));
  assert.ok(store.hasProof(voidKey(5)));
  assert.equal(store.dropSpentDepositProofs(), 0);
});
