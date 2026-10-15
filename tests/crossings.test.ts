/**
 * What the Antelope relayers append is read from where the store left off, a line
 * still being written is left for next time, and a line read twice is the same
 * upsert twice.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Store, depositKey, withdrawalKey } from '../services/indexer/db.ts';
import { ingestCrossings } from '../services/indexer/crossings.ts';
import { antelopeById, crossingsFiles } from '../src/chains/antelope.ts';

const NAMES = ['wax-in', 'wax-out'];

const DOMAIN = '1181148696416462999';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'alcor-crossings-'));
  mkdirSync(join(dir, 'wax-in'));
  mkdirSync(join(dir, 'wax-out'));
  return { dir, store: new Store(':memory:'), line: (name: string, text: string) => appendFileSync(join(dir, name, 'crossings.jsonl'), text) };
}

test('a deposit is a row the moment it is seen, and gets its Telos half when proved', () => {
  const { dir, store, line } = setup();
  line('wax-in', JSON.stringify({ kind: 'deposit', domain: DOMAIN, nonce: 4, token: 'AB', wax_tx: 'w1', wax_block: 10, from: 'bob.wam', amount: '1000000', beneficiary: 'alice', memo: 'hi', at: 1000 }) + '\n');
  assert.equal(ingestCrossings(store, dir, NAMES), 1);
  let row = store.getTransfer(depositKey(DOMAIN, 4))!;
  assert.equal(row.status, 'seen');
  assert.equal(row.src_tx, 'w1');
  assert.equal(row.src_block, 10);
  assert.equal(row.token, 'ab');
  assert.equal(row.account, 'alice');
  assert.equal(row.evm_address, 'bob.wam');
  assert.equal(row.amount, '1000000');
  assert.equal(row.memo, 'hi');
  assert.equal(row.dst_tx, null);

  line('wax-in', JSON.stringify({ kind: 'deposit', domain: DOMAIN, nonce: 4, token: 'AB', wax_tx: 'w1', wax_block: 10, telos_tx: 't1', at: 1050 }) + '\n');
  assert.equal(ingestCrossings(store, dir, NAMES), 1);
  row = store.getTransfer(depositKey(DOMAIN, 4))!;
  assert.equal(row.dst_tx, 't1');
  assert.equal(row.src_time, 1000);
  assert.equal(row.account, 'alice');

  // A line still being written waits; the offset holds until it is complete.
  line('wax-in', '{"kind":"deposit","dom');
  assert.equal(ingestCrossings(store, dir, NAMES), 0);
  line('wax-in', 'ain":"' + DOMAIN + '","nonce":5,"wax_tx":"w2","wax_block":11,"telos_tx":"t2","at":1001}\n');
  assert.equal(ingestCrossings(store, dir, NAMES), 1);
  assert.equal(store.getTransfer(depositKey(DOMAIN, 5))?.src_tx, 'w2');
});

test('a release ends a withdrawal; an expiry does not, a void refunds it', () => {
  const { dir, store, line } = setup();
  store.upsertTransfer({ key: withdrawalKey(7), direction: 'withdrawal', ref: 7, status: 'burned', src_block: 5, src_time: 1, account: 'alice' });
  line('wax-out', JSON.stringify({ kind: 'withdrawal', id: 7, action: 'expire', telos_block: 5, wax_tx: 'wx', at: 2 }) + '\n');
  line('wax-out', JSON.stringify({ kind: 'withdrawal', id: 8, action: 'release', telos_block: 6, wax_tx: 'wr', at: 3 }) + '\n');
  line('wax-in', JSON.stringify({ kind: 'voided', id: 7, wax_tx: 'wx', wax_block: 12, at: 4 }) + '\n');
  assert.equal(ingestCrossings(store, dir, NAMES), 3);
  assert.equal(store.getTransfer(withdrawalKey(7))!.status, 'expired');
  line('wax-in', JSON.stringify({ kind: 'voided', id: 7, wax_tx: 'wx', wax_block: 12, telos_tx: 'tv', at: 5 }) + '\n');
  assert.equal(ingestCrossings(store, dir, NAMES), 1);

  const seven = store.getTransfer(withdrawalKey(7))!;
  assert.equal(seven.status, 'refunded');
  assert.equal(seven.dst_block, 12);
  assert.equal(seven.refund_tx, 'tv');
  assert.equal(seven.dst_tx, 'wx');
  assert.equal(seven.account, 'alice');
  const eight = store.getTransfer(withdrawalKey(8))!;
  assert.equal(eight.status, 'released');
  assert.equal(eight.dst_tx, 'wr');
  assert.equal(eight.src_block, 6);
});

test('a bad line is skipped and does not stop the file', () => {
  const { dir, store, line } = setup();
  line('wax-in', 'not json\n');
  line('wax-in', JSON.stringify({ kind: 'deposit', domain: DOMAIN, nonce: 1, wax_tx: 'w', wax_block: 1, telos_tx: 't', at: 1 }) + '\n');
  assert.equal(ingestCrossings(store, dir, NAMES), 1);
  assert.equal(ingestCrossings(store, dir, NAMES), 0);
});

test('Vaulta\'s relayers write the same lines under their own names, and its twenty-digit domain stays exact', () => {
  const vaulta = antelopeById('vaulta')!;
  const names = crossingsFiles(vaulta);
  assert.deepEqual(names, ['vaulta-in', 'vaulta-out']);
  const dir = mkdtempSync(join(tmpdir(), 'alcor-crossings-'));
  for (const name of names) mkdirSync(join(dir, name));
  const store = new Store(':memory:');
  const line = (name: string, text: string) => appendFileSync(join(dir, name, 'crossings.jsonl'), text);

  // As vaulta-in writes it: once, when the credit lands on Telos.
  line('vaulta-in', JSON.stringify({ kind: 'deposit', domain: vaulta.domain, nonce: 1, token: 'AB', wax_tx: 'v1', wax_block: 524341707, telos_tx: 't1', at: 1000 }) + '\n');
  line('vaulta-out', JSON.stringify({ kind: 'withdrawal', id: 9, action: 'release', telos_block: 492920369, wax_tx: 'vr', at: 1001 }) + '\n');
  // A WAX file beside them is not read under Vaulta's names.
  mkdirSync(join(dir, 'wax-in'));
  line('wax-in', JSON.stringify({ kind: 'deposit', domain: DOMAIN, nonce: 1, wax_tx: 'w', wax_block: 1, telos_tx: 't', at: 1 }) + '\n');
  assert.equal(ingestCrossings(store, dir, names), 2);

  const row = store.getTransfer(depositKey('12439917377594391589', 1))!;
  assert.equal(row.domain, '12439917377594391589');
  assert.equal(row.src_tx, 'v1');
  assert.equal(row.dst_tx, 't1');
  assert.equal(store.getTransfer(withdrawalKey(9))!.status, 'released');
  assert.equal(store.getTransfer(depositKey(DOMAIN, 1)), undefined);
});
