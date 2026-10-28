/**
 * The activity feed: one entry per transfer as a person sees it, hop legs and
 * bounce-backs folded in, and sums that count each transfer once.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { activities, activityOf, feed, summary, type ActivityContext } from '../services/indexer/activity.ts';
import { Store, depositKey, withdrawalKey } from '../services/indexer/db.ts';
import type { ProgressContext } from '../services/indexer/progress.ts';
import { decimalAmount, decimalUnits } from '../src/units.ts';
import { antelopeDepositEta, antelopeWithdrawalEta } from '../src/chains/eta.ts';
import { antelopeById } from '../src/chains/antelope.ts';

const waxChain = antelopeById('wax')!;

const HOP = 'hop.alcor';
const WAX = '1181148696416462999';
const USDC_ETH = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const USDC_WAX = 'usdc-on-wax';
const USER = '0x' + 'ab'.repeat(20);
const DAY = 24 * 3600;
const NOW = Date.parse('2026-10-07T12:00:00Z') / 1000;

const progress: ProgressContext = {
  now: NOW,
  evmHead: () => undefined,
  route: () => undefined,
  chainName: (d) => (d === '1' ? 'Ethereum' : d === WAX ? 'WAX' : 'the far chain'),
  isAntelope: (d) => d === WAX,
  depositEta: (d) => (d === WAX ? antelopeDepositEta(waxChain) : null),
  withdrawalEta: (d) => (d === WAX ? antelopeWithdrawalEta(waxChain) : null),
  hold: () => null,
};

const ctx: ActivityContext = {
  hop: HOP,
  chainOf: (d) => (d === '1' ? 'mainnet' : d === WAX ? 'wax' : null),
  asset: (token) => (token === USDC_ETH || token === USDC_WAX ? { symbol: 'USDC', precision: 6 } : undefined),
  progress,
};

const kind = (c: string | null) => (c === 'mainnet' ? 'evm' : c === 'telos' || c === 'wax' ? 'antelope' : null);

/** Ethereum -> Telos -> WAX: deposit 30 to the hop, carried on as withdrawal 7. */
function hopEthToWax(store: Store, at: number, legStatus: 'burned' | 'released') {
  const dKey = depositKey(1, 30);
  store.upsertTransfer({
    key: dKey, direction: 'deposit', ref: 30, status: 'forwarded', account: HOP, evm_address: USER, token: USDC_ETH,
    domain: '1', amount: '44125906000', memo: `${WAX}:alice.wam|1:${USER}`, src_block: 100, src_time: at, src_tx: '0xsrc',
  });
  store.putHop({
    id: 7, prev: null, deposit: dKey, quantity: '44125.906000 USDC', to_domain: WAX, to_recipient: 'alice.wam',
    back_domain: '1', back_recipient: USER, tx: 'tbind', block: 200, at: at + 60,
  });
  store.upsertTransfer({
    key: withdrawalKey(7), direction: 'withdrawal', ref: 7, status: legStatus, account: HOP, evm_address: 'alice.wam',
    token: USDC_WAX, domain: WAX, amount: '44125906000', src_block: 200, src_time: at + 60, src_tx: 'tbind',
    ...(legStatus === 'released' ? { dst_time: at + 300, dst_tx: 'twax' } : {}),
  });
  return dKey;
}

test('a hop is one transfer keyed by its deposit, and its leg is not a transfer of its own', () => {
  const store = new Store(':memory:');
  const key = hopEthToWax(store, NOW - 600, 'released');
  const all = activities(store, ctx);
  assert.equal(all.length, 1);
  assert.deepEqual(all[0], {
    key,
    kind: 'hop',
    from: { chain: 'mainnet', address: USER },
    to: { chain: 'wax', recipient: 'alice.wam' },
    asset: { symbol: 'USDC', precision: 6 },
    amount: '44125.906',
    state: 'delivered',
    waitingOn: null,
    stage: 'Arrived on WAX',
    percent: 100,
    exact: true,
    etaAt: null,
    startedAt: NOW - 600,
    finishedAt: NOW - 300,
    srcTx: '0xsrc',
    dstTx: 'twax',
  });
});

test('a hop whose leg waits for a release on Ethereum needs the user', () => {
  const store = new Store(':memory:');
  const dKey = depositKey(WAX, 28);
  store.upsertTransfer({
    key: dKey, direction: 'deposit', ref: 28, status: 'forwarded', account: HOP, evm_address: 'zr1ko.c.wam',
    token: USDC_WAX, domain: WAX, amount: '5000000', src_block: 1, src_time: NOW - 900,
  });
  store.putHop({
    id: 53, prev: null, deposit: dKey, quantity: '5.000000 USDC', to_domain: '1', to_recipient: USER,
    back_domain: WAX, back_recipient: 'zr1ko.c.wam', tx: 'tb', block: 2, at: NOW - 800,
  });
  store.upsertTransfer({
    key: withdrawalKey(53), direction: 'withdrawal', ref: 53, status: 'provable', account: HOP, evm_address: USER,
    token: USDC_ETH, domain: '1', amount: '5000000', src_block: 2, src_time: NOW - 800,
  });
  const [a] = activities(store, ctx);
  assert.equal(a.key, dKey);
  assert.equal(a.state, 'action_needed');
  assert.equal(a.waitingOn, 'user');
  assert.equal(a.stage, 'Ready to claim on Ethereum');
  assert.equal(a.finishedAt, null);
  assert.equal(a.dstTx, null);
});

test('direct transfers keep their own keys and read from the sender to the recipient', () => {
  const store = new Store(':memory:');
  store.upsertTransfer({
    key: depositKey(1, 1), direction: 'deposit', ref: 1, status: 'credited', account: 'bob', evm_address: USER,
    token: USDC_ETH, domain: '1', amount: '5000000', src_block: 1, src_time: NOW - 100, dst_time: NOW - 50, dst_tx: 'tc',
  });
  store.upsertTransfer({
    key: withdrawalKey(2), direction: 'withdrawal', ref: 2, status: 'provable', account: 'bob', evm_address: USER,
    token: USDC_ETH, domain: '1', amount: '1500000', src_block: 2, src_time: NOW - 10,
  });
  const [w, d] = activities(store, ctx);
  assert.deepEqual([w.key, w.kind, w.state, w.from, w.to, w.amount], [
    'w:2', 'direct', 'action_needed', { chain: 'telos', address: 'bob' }, { chain: 'mainnet', recipient: USER }, '1.5',
  ]);
  assert.deepEqual([d.key, d.state, d.from, d.to, d.finishedAt, d.dstTx], [
    'd:1:1', 'delivered', { chain: 'mainnet', address: USER }, { chain: 'telos', recipient: 'bob' }, NOW - 50, 'tc',
  ]);
});

test('a refused deposit and the withdrawal sending it back are one returned transfer', () => {
  const store = new Store(':memory:');
  store.upsertTransfer({
    key: depositKey(1, 4), direction: 'deposit', ref: 4, status: 'bounced', account: 'nobody', evm_address: USER,
    token: USDC_ETH, domain: '1', amount: '5000000', src_block: 1, src_time: NOW - 5000, dst_tx: 'tback',
  });
  store.upsertTransfer({
    key: withdrawalKey(9), direction: 'withdrawal', ref: 9, status: 'released', account: 'bridge.alcor', evm_address: USER,
    token: USDC_ETH, domain: '1', amount: '5000000', src_block: 5, src_time: NOW - 3600, src_tx: 'tback',
    dst_time: NOW - 1000, dst_tx: '0xrefund',
  });
  const all = activities(store, ctx);
  assert.equal(all.length, 1);
  assert.deepEqual([all[0].key, all[0].state, all[0].finishedAt, all[0].dstTx], ['d:1:4', 'returned', NOW - 1000, '0xrefund']);
});

test('any key of a transfer finds that transfer, as the feed shows it', () => {
  const store = new Store(':memory:');
  const hop = hopEthToWax(store, NOW - 600, 'burned');
  store.upsertTransfer({
    key: depositKey(1, 4), direction: 'deposit', ref: 4, status: 'bounced', account: 'nobody', evm_address: USER,
    token: USDC_ETH, domain: '1', amount: '5000000', src_block: 1, src_time: NOW - 5000, dst_tx: 'tback',
  });
  store.upsertTransfer({
    key: withdrawalKey(9), direction: 'withdrawal', ref: 9, status: 'expired', account: 'bridge.alcor', evm_address: USER,
    token: USDC_ETH, domain: '1', amount: '5000000', src_block: 5, src_time: NOW - 3600, src_tx: 'tback',
  });
  store.upsertTransfer({
    key: withdrawalKey(2), direction: 'withdrawal', ref: 2, status: 'provable', account: 'bob', evm_address: USER,
    token: USDC_ETH, domain: '1', amount: '1500000', src_block: 2, src_time: NOW - 10,
  });
  // A leg of the hop account with no journey behind it: left out of the feed, and so here.
  store.upsertTransfer({
    key: withdrawalKey(11), direction: 'withdrawal', ref: 11, status: 'burned', account: HOP, evm_address: USER,
    token: USDC_ETH, domain: '1', amount: '1000000', src_block: 3, src_time: NOW - 20,
  });

  const byKey = new Map(activities(store, ctx).map((a) => [a.key, a]));
  const cases: [string, string | undefined][] = [
    [hop, hop], [withdrawalKey(7), hop],
    ['d:1:4', 'd:1:4'], [withdrawalKey(9), 'd:1:4'], ['v:9', 'd:1:4'],
    [withdrawalKey(2), 'w:2'],
    [withdrawalKey(11), undefined], ['w:404', undefined],
  ];
  for (const [key, owner] of cases) {
    assert.deepEqual(activityOf(store, key, ctx), owner === undefined ? undefined : byKey.get(owner), key);
  }
});

test('the summary counts a hop once, by its ends, and moves no total for what came back', () => {
  const store = new Store(':memory:');
  hopEthToWax(store, NOW - 600, 'released');
  // Telos -> WAX: between two Antelope chains, counted and not a flow.
  store.upsertTransfer({
    key: withdrawalKey(20), direction: 'withdrawal', ref: 20, status: 'released', account: 'bob', evm_address: 'bob.wam',
    token: USDC_WAX, domain: WAX, amount: '7000000', src_block: 3, src_time: NOW - 2 * DAY, dst_time: NOW - 2 * DAY + 90,
  });
  // Telos -> Ethereum, delivered: out of Antelope.
  store.upsertTransfer({
    key: withdrawalKey(21), direction: 'withdrawal', ref: 21, status: 'released', account: 'bob', evm_address: USER,
    token: USDC_ETH, domain: '1', amount: '2000000', src_block: 4, src_time: NOW - 2 * DAY, dst_time: NOW - 2 * DAY + 1800,
  });
  // Telos -> Ethereum, rolled back: a transfer, no volume.
  store.upsertTransfer({
    key: withdrawalKey(22), direction: 'withdrawal', ref: 22, status: 'refunded', account: 'carol', evm_address: USER,
    token: USDC_ETH, domain: '1', amount: '9000000', src_block: 5, src_time: NOW - 40 * DAY, refund_tx: 'tr',
  });

  const all = activities(store, ctx);
  const s = summary(all, 'all', NOW, kind);
  assert.equal(s.transfers, 4);
  assert.equal(s.since, null);
  assert.equal(s.wallets, 3); // USER, bob, carol
  assert.deepEqual(s.byState, { in_progress: 0, action_needed: 0, delivered: 3, returned: 1 });
  assert.deepEqual(s.assets, [
    { symbol: 'USDC', precision: 6, transfers: 4, toAntelope: '44125.906', fromAntelope: '2', net: '44123.906' },
  ]);
  assert.deepEqual(s.duration, { median: 300, p90: 1800 });
  assert.deepEqual(
    s.routes.map((r) => [r.from, r.to, r.transfers, r.amounts]),
    [
      ['telos', 'mainnet', 2, [{ symbol: 'USDC', amount: '2' }]],
      ['mainnet', 'wax', 1, [{ symbol: 'USDC', amount: '44125.906' }]],
      ['telos', 'wax', 1, [{ symbol: 'USDC', amount: '7' }]],
    ],
  );
  // Every day from the first transfer to today, empty ones included.
  assert.equal(s.daily.length, 41);
  assert.deepEqual(s.daily.at(-1), { day: '2026-10-07', transfers: 1, amounts: [{ symbol: 'USDC', amount: '44125.906' }] });
  assert.deepEqual(s.daily.at(-2), { day: '2026-10-06', transfers: 0, amounts: [] });

  const week = summary(all, '7d', NOW, kind);
  assert.equal(week.since, NOW - 7 * DAY);
  assert.equal(week.transfers, 3);
  assert.equal(week.daily.length, 8);
  assert.equal(summary([], '24h', NOW, kind).duration, null);
});

test('the feed pages by cursor and finds a party at either end', () => {
  const store = new Store(':memory:');
  for (let i = 1; i <= 5; i++) {
    store.upsertTransfer({
      key: depositKey(1, i), direction: 'deposit', ref: i, status: 'credited', account: `acct${i}`,
      evm_address: i % 2 ? USER : '0x' + 'cd'.repeat(20), token: USDC_ETH, domain: '1', amount: '5000000',
      src_block: i, src_time: NOW - 100 * i,
    });
  }
  hopEthToWax(store, NOW - 50, 'burned'); // USER again, as the sender
  const all = activities(store, ctx);

  const first = feed(all, {}, 4);
  assert.deepEqual(first.items.map((a) => a.key), ['d:1:30', 'd:1:1', 'd:1:2', 'd:1:3']);
  const second = feed(all, {}, 4, first.cursor!);
  assert.deepEqual(second.items.map((a) => a.key), ['d:1:4', 'd:1:5']);
  assert.equal(second.cursor, null);

  // As the sender, and as the recipient over there.
  assert.deepEqual(
    feed(all, { party: USER.toUpperCase().replace('0X', '0x') }, 25).items.map((a) => a.key),
    ['d:1:30', 'd:1:1', 'd:1:3', 'd:1:5'],
  );
  assert.deepEqual(feed(all, { party: 'alice.wam' }, 25).items.map((a) => a.kind), ['hop']);
  assert.deepEqual(feed(all, { party: 'acct2' }, 25).items.map((a) => a.key), ['d:1:2']);

  // The start of a name is enough; the middle of one is not.
  assert.deepEqual(feed(all, { party: ' ALI ' }, 25).items.map((a) => a.kind), ['hop']);
  assert.deepEqual(
    feed(all, { party: USER.slice(0, 8) }, 25).items.map((a) => a.key),
    ['d:1:30', 'd:1:1', 'd:1:3', 'd:1:5'],
  );
  assert.equal(feed(all, { party: 'ice.wam' }, 25).items.length, 0);
  assert.equal(feed(all, { chain: 'wax' }, 25).items.length, 1);
  assert.equal(feed(all, { state: 'in_progress' }, 25).items.length, 1);
  assert.equal(feed(all, { asset: 'usdc' }, 25).items.length, 6);
  assert.throws(() => feed(all, {}, 4, 'garbage'), /cursor/);
});

test('decimal amounts are exact both ways', () => {
  assert.equal(decimalAmount('2259027309', 6), '2259.027309');
  assert.equal(decimalAmount(-500000n, 6), '-0.5');
  assert.equal(decimalUnits('2259.027309', 6), 2259027309n);
  assert.equal(decimalUnits('-0.5', 6), -500000n);
  assert.equal(decimalUnits('20', 8), 2000000000n);
  assert.throws(() => decimalUnits('1.1234567', 6));
});
