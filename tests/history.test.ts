/**
 * Completing half-described rows from action history, and the amount a person
 * reads.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Store, depositKey, withdrawalKey, type ChainAction } from '../services/indexer/db.ts';
import { applyBurns, applyCredits, applyDeplogs, applySettlements } from '../services/indexer/history.ts';
import { humanAmount } from '../services/indexer/units.ts';

const WAX = '1181148696416462999';

const action = (name: string, block: number, trx: string, timestamp: string, data: Record<string, unknown>): ChainAction => ({
  chain: 'x',
  seq: trx,
  account: 'x',
  name,
  block_num: block,
  trx_id: trx,
  time: Math.floor(Date.parse(`${timestamp}Z`) / 1000),
  data,
});

test('humanAmount drops trailing zeros and keeps the symbol', () => {
  assert.equal(humanAmount('2000000000', 8, 'WAX'), '20 WAX');
  assert.equal(humanAmount('100000', 8, 'ETH'), '0.001 ETH');
  assert.equal(humanAmount('5000000', 6, 'USDC'), '5 USDC');
  assert.equal(humanAmount('1234567', 6, 'USDT'), '1.234567 USDT');
  assert.equal(humanAmount('0', 4, 'X'), '0 X');
  assert.equal(humanAmount(7n, 0, 'N'), '7 N');
});

test('a credit from history gives a deposit its token and its Telos transaction', () => {
  const store = new Store(':memory:');
  const key = depositKey(WAX, 2);
  store.upsertTransfer({ key, direction: 'deposit', ref: 2, status: 'credited', domain: WAX, account: 'carol', amount: '1000000', src_block: 0, src_time: 1790782284 });
  const credits = [
    action('credit', 491522873, 'f7f3', '2026-09-30T15:23:30.500', { domain: WAX, nonce: '1', ext_token: '00A6', beneficiary: 'alcor', canonical: '100000000', memo: '' }),
    action('credit', 491523821, '8670', '2026-09-30T15:31:24.500', { domain: WAX, nonce: '2', ext_token: '00C0A5', beneficiary: 'carol', canonical: '1000000', memo: 'note' }),
    action('credit', 491478698, '79da', '2026-09-30T09:15:18.000', { domain: '1', nonce: '2', ext_token: 'A0B8', beneficiary: 'x', canonical: '1', memo: '' }),
  ];
  assert.equal(applyCredits(store, [store.getTransfer(key)!], credits), 1);
  const row = store.getTransfer(key)!;
  assert.equal(row.token, '00c0a5'); // the WAX nonce 2, not mainnet's
  assert.equal(row.dst_tx, '8670');
  assert.equal(row.dst_block, 491523821);
  assert.equal(row.dst_time, Math.floor(Date.parse('2026-09-30T15:31:24.500Z') / 1000));
  assert.equal(row.memo, 'note');
  assert.equal(row.status, 'credited');
  assert.equal(row.src_time, 1790782284);
});

test('a deplog from WAX history gives a deposit where it started', () => {
  const store = new Store(':memory:');
  const key = depositKey(WAX, 1);
  store.upsertTransfer({ key, direction: 'deposit', ref: 1, status: 'credited', domain: WAX, src_block: 0, src_time: 1790781810 });
  const deplogs = [action('deplog', 458589420, 'fb0f', '2026-09-30T15:22:30.000', { nonce: '1', from: 'alcor', memo: '' })];
  assert.equal(applyDeplogs(store, WAX, [store.getTransfer(key)!], deplogs), 1);
  const row = store.getTransfer(key)!;
  assert.equal(row.src_tx, 'fb0f');
  assert.equal(row.src_block, 458589420);
  assert.equal(row.evm_address, 'alcor');
  assert.equal(row.src_time, Math.floor(Date.parse('2026-09-30T15:22:30.000Z') / 1000));
  // A row on another domain with the same nonce is not touched.
  const other = depositKey('1', 1);
  store.upsertTransfer({ key: other, direction: 'deposit', ref: 1, status: 'credited', domain: '1', src_block: 5, src_time: 9 });
  assert.equal(applyDeplogs(store, WAX, [store.getTransfer(other)!], deplogs), 0);
});

test('a wdlog from Telos history gives a withdrawal the transaction that burned it', () => {
  const store = new Store(':memory:');
  const key = withdrawalKey(2);
  store.upsertTransfer({ key, direction: 'withdrawal', ref: 2, status: 'released', domain: WAX, src_block: 491522788, src_time: 1790781768 });
  const wdlogs = [
    action('wdlog', 491410957, '85ac', '2026-09-29T23:50:46.500', { id: '1', domain: '1' }),
    action('wdlog', 491522788, '4fa6', '2026-09-30T15:22:48.000', { id: '2', domain: WAX }),
  ];
  assert.equal(applyBurns(store, [store.getTransfer(key)!], wdlogs), 1);
  const row = store.getTransfer(key)!;
  assert.equal(row.src_tx, '4fa6');
  assert.equal(row.src_time, Math.floor(Date.parse('2026-09-30T15:22:48.000Z') / 1000));
  assert.equal(row.status, 'released');
});

test('a release from WAX history is matched by the id in its packed payload', () => {
  const store = new Store(':memory:');
  const key = withdrawalKey(3);
  store.upsertTransfer({ key, direction: 'withdrawal', ref: 3, status: 'released', domain: WAX, src_block: 491523709, src_time: 1790782228 });
  const releases = [
    action('release', 458590328, '93c0', '2026-09-30T15:30:04.000', { payer: 'relay.alcor', data: '020000000000000097a8d13c' }),
    action('release', 458590538, 'ab58', '2026-09-30T15:31:49.000', { payer: 'relay.alcor', data: '030000000000000097a8d13c' }),
  ];
  assert.equal(applySettlements(store, WAX, [store.getTransfer(key)!], releases), 1);
  const row = store.getTransfer(key)!;
  assert.equal(row.dst_tx, 'ab58');
  assert.equal(row.dst_block, 458590538);
  assert.equal(row.status, 'released');
});
