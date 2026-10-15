/**
 * The volume report: what counts as crossed, sums past 2^53, people counted
 * once per window, the average and the busiest day.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Store, depositKey, withdrawalKey } from '../services/indexer/db.ts';
import { volume, type Describe } from '../services/indexer/volume.ts';

const WAX = '1181148696416462999';
const DAY = 24 * 3600;
const NOW = Date.parse('2026-10-01T12:00:00Z') / 1000;

const describe: Describe = (domain, token) =>
  domain === WAX && token === 'aa'
    ? { chain: 'wax', symbol: 'WAX', precision: 8 }
    : { chain: null, symbol: null, precision: null };

function seed() {
  const store = new Store(':memory:');
  const deposit = (nonce: number, status: string, account: string, from: string, amount: string, at: number) =>
    store.upsertTransfer({ key: depositKey(WAX, nonce), direction: 'deposit', ref: nonce, status: status as any, domain: WAX, token: 'aa', account, evm_address: from, amount, src_block: 1, src_time: at });
  const withdrawal = (id: number, status: string, account: string, to: string, amount: string, at: number) =>
    store.upsertTransfer({ key: withdrawalKey(id), direction: 'withdrawal', ref: id, status: status as any, domain: WAX, token: 'aa', account, evm_address: to, amount, src_block: 1, src_time: at });

  deposit(1, 'credited', 'alice', 'a.wam', '6000000000000000', NOW - 10 * DAY); // 60M WAX, 2^53 is ~90M
  deposit(2, 'credited', 'alice', 'A.WAM', '6000000000000000', NOW - 3 * DAY);
  deposit(3, 'parked', 'bob', 'b.wam', '100000000', NOW - 3600);
  deposit(4, 'seen', 'carol', 'c.wam', '100000000', NOW - 60); // not booked yet
  withdrawal(1, 'released', 'alice', 'a.wam', '500000000', NOW - 3 * DAY);
  withdrawal(2, 'burned', 'bob', 'b.wam', '200000000', NOW - 3600);
  withdrawal(3, 'refunded', 'carol', 'c.wam', '900000000', NOW - 3600); // rolled back, never left
  return store;
}

test('volume counts booked deposits and withdrawals that left, per window', () => {
  const report = volume(seed(), describe, NOW, 30);
  const find = (w: string, dir: string) => report.windows[w].assets.find((a) => a.direction === dir)!;

  assert.equal(find('all', 'deposit').count, 3);
  assert.equal(find('all', 'deposit').amount, '12000000100000000'); // past 2^53, exact
  assert.equal(find('all', 'deposit').amountHuman, '120000001 WAX');
  assert.equal(find('all', 'deposit').accounts, 2);
  assert.equal(find('all', 'deposit').addresses, 2); // a.wam and A.WAM are one address

  assert.equal(find('24h', 'deposit').count, 1);
  assert.equal(find('24h', 'withdrawal').count, 1);
  assert.equal(find('24h', 'withdrawal').amountHuman, '2 WAX');
  assert.equal(find('7d', 'withdrawal').amountHuman, '7 WAX');
  assert.equal(find('7d', 'withdrawal').perDayHuman, '1 WAX');

  assert.deepEqual(report.windows['24h'].people.all, { accounts: 1, addresses: 1 }); // bob; carol's are not counted
  assert.deepEqual(report.windows.all.people.withdrawal, { accounts: 2, addresses: 2 });
});

test('the busiest day is found within the window, and daily is oldest first', () => {
  const report = volume(seed(), describe, NOW, 30);
  const deposits = report.windows['30d'].assets.find((a) => a.direction === 'deposit')!;
  assert.equal(deposits.peakDay?.day, '2026-09-21');
  assert.equal(deposits.peakDay?.amountHuman, '60000000 WAX');
  const week = report.windows['7d'].assets.find((a) => a.direction === 'deposit')!;
  assert.equal(week.peakDay?.day, '2026-09-28');

  assert.deepEqual(report.daily.map((d) => d.day), ['2026-09-21', '2026-09-28', '2026-09-28', '2026-10-01', '2026-10-01']);
  assert.deepEqual(volume(seed(), describe, NOW, 2).daily.map((d) => d.day), ['2026-10-01', '2026-10-01']);
});
