/**
 * Swaps at the far end of a crossing: bridgeroute's `opened` and `closed` from
 * the stream become one row per order, found by the payout's transaction, and a
 * line a person can read. And the quote endpoint's refusals, which need no
 * aggregator to answer.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { Store, type ChainAction } from '../services/indexer/db.ts';
import { applySwapActions, swapOfPayout, wellFormedOpened } from '../services/indexer/swaps.ts';
import { hopLink } from '../services/indexer/hops.ts';
import { evmSwapQuote, QuoteRefused } from '../services/indexer/quote.ts';

const action = (name: string, trx: string, timestamp: string, data: Record<string, unknown>): ChainAction => ({
  chain: 'x',
  seq: trx,
  account: 'route.alcor',
  name,
  block_num: 1,
  trx_id: trx,
  time: Math.floor(Date.parse(`${timestamp}Z`) / 1000),
  data,
});
const USDC = (q: string) => ({ quantity: `${q} USDC`, contract: 'wrap.alcor' });
const TLM = (q: string) => ({ quantity: `${q} TLM`, contract: 'alien.worlds' });

type Tokens = { quantity: string; contract: string };
const opened = (id: number, trx: string, to = 'alice', back = to) =>
  action('opened', trx, '2026-10-12T20:00:00.000', {
    id, to, back, in: USDC('100.000000'), least: TLM('403.5737'), deadline: '2026-10-12T20:30:00',
  });
const closed = (id: number, trx: string, outcome: string, paid: Tokens[], to = 'alice') =>
  action('closed', trx, '2026-10-12T20:00:05.000', { id, outcome, paid: paid.map((tokens) => ({ to, tokens })) });

test('an order opened by its payout, then swapped', () => {
  const store = new Store(':memory:');
  applySwapActions(store, 'wax', [opened(1, 'payout1')]);
  assert.equal(swapOfPayout(store, 'payout1')?.summary, 'swapping into at least 403.5737 TLM');

  applySwapActions(store, 'wax', [closed(1, 'exec1', 'swapped', [TLM('410.1234')])]);
  const swap = swapOfPayout(store, 'payout1')!;
  assert.equal(swap.status, 'swapped');
  assert.equal(swap.summary, 'delivered as 410.1234 TLM');
  assert.equal(swap.closedTx, 'exec1');
  assert.equal(swap.deadline, Date.UTC(2026, 9, 12, 20, 30) / 1000);
  assert.deepEqual(swap.paid, [{ to: 'alice', asset: '410.1234 TLM@alien.worlds' }]);
  assert.deepEqual(swap.onward, [], 'delivered on its own chain');
  assert.equal(swapOfPayout(store, 'exec1'), null, 'found by the payout, not by the swap');
});

test('a swap with change, and both actions in one block', () => {
  const store = new Store(':memory:');
  applySwapActions(store, 'vaulta', [opened(4, 'payout4', 'alice', 'bob'), action('closed', 'exec4', '2026-10-12T20:00:05.000', {
    id: 4, outcome: 'swapped', paid: [{ to: 'alice', tokens: TLM('400.0000') }, { to: 'bob', tokens: USDC('1.500000') }],
  })]);
  const swap = swapOfPayout(store, 'payout4')!;
  assert.equal(swap.summary, 'delivered as 400.0000 TLM + 1.500000 USDC');
  assert.deepEqual([swap.to, swap.back], ['alice', 'bob']);
});

test('a payout paid on at once: its closed is the whole order, in its own transaction', () => {
  const store = new Store(':memory:');
  applySwapActions(store, 'xpr', [closed(2, 'payout2', 'unread', [USDC('50.000000')])]);
  const swap = swapOfPayout(store, 'payout2')!;
  assert.equal(swap.status, 'unread');
  assert.equal(swap.summary, 'refunded as 50.000000 USDC: the memo was not understood');
  assert.equal(swap.input, '50.000000 USDC@wrap.alcor');
  assert.deepEqual([swap.to, swap.back], ['alice', 'alice'], 'where it went, the only place the closed names');
});

test('a swap on Telos delivered to another chain names the withdrawal that carries it on', () => {
  const store = new Store(':memory:');
  const BSC = '56:0x5b38da6a701c568545dcfcb03fcb875f56beddc4';
  const POLYGON = '137:0x5b38da6a701c568545dcfcb03fcb875f56beddc4';
  applySwapActions(store, 'telos', [opened(6, 'forward6', BSC, POLYGON)]);
  const swapping = swapOfPayout(store, 'forward6')!;
  assert.deepEqual([swapping.to, swapping.back, swapping.onward], [BSC, POLYGON, []]);

  applySwapActions(store, 'telos', [closed(6, 'exec6', 'swapped', [{ quantity: '99.700000 USDT', contract: 'wrap.alcor' }], BSC)]);
  assert.deepEqual(swapOfPayout(store, 'forward6')!.onward, [], 'the withdrawal not read yet');
  store.upsertTransfer({
    key: 'w:300', direction: 'withdrawal', ref: 300, status: 'burned', account: 'hop.alcor',
    evm_address: '0x5b38da6a701c568545dcfcb03fcb875f56beddc4', domain: '56', amount: '99700000',
    src_block: 10, src_time: 1000, src_tx: 'exec6',
  });
  const swapped = swapOfPayout(store, 'forward6')!;
  assert.equal(swapped.summary, 'delivered as 99.700000 USDT');
  assert.deepEqual(swapped.paid, [{ to: BSC, asset: '99.700000 USDT@wrap.alcor' }]);
  assert.deepEqual(swapped.onward, ['w:300']);
});

test('a leg a Telos order sent names the order, how it ended, and the deposit that paid it in', () => {
  const store = new Store(':memory:');
  const OWNER = '0x5b38da6a701c568545dcfcb03fcb875f56beddc4';
  const REFUND = '0xab8483f64d9c6d1ecf9b849ae677dd3315835cb2';
  store.upsertTransfer({
    key: 'd:56:9', direction: 'deposit', ref: 9, status: 'forwarded', account: 'route.alcor', evm_address: '0x1111111111111111111111111111111111111111',
    domain: '56', amount: '50000000', src_block: 5, src_time: 900, src_tx: 'bsc9', dst_tx: 'forward9',
  });
  const leg = (id: number, recipient: string, tx: string, prev: number | null = null) => {
    store.putHop({
      id, prev, deposit: null, quantity: '50.000000 USDC', to_domain: '56', to_recipient: recipient,
      back_domain: '56', back_recipient: recipient, tx, block: 10, at: 1000,
    });
    store.upsertTransfer({
      key: `w:${id}`, direction: 'withdrawal', ref: id, status: 'burned', account: 'hop.alcor', evm_address: recipient,
      domain: '56', amount: '50000000', src_block: 10, src_time: 1000, src_tx: tx,
    });
    return hopLink(store, store.getTransfer(`w:${id}`)!, () => 'bsc')!;
  };
  applySwapActions(store, 'telos', [
    opened(9, 'forward9', `56:${OWNER}`, `56:${REFUND}`),
    closed(9, 'exec9', 'expired', [USDC('50.000000')], `56:${REFUND}`),
    // Another order ended in the same transaction, delivering somewhere else.
    closed(10, 'exec9', 'swapped', [USDC('7.000000')], `56:${OWNER}`),
  ]);
  assert.deepEqual(leg(400, REFUND.slice(2).toUpperCase(), 'exec9').order, { chain: 'telos', id: 9, status: 'expired', deposit: 'd:56:9' });
  assert.equal(leg(401, '0x2222222222222222222222222222222222222222', 'exec9').order, null, 'no order there delivered to it');
  assert.equal(leg(402, REFUND, 'other').order, null, 'no order ended in its transaction');
  assert.equal(leg(403, REFUND, 'recover403', 400).order, null, 'a way back is no order\'s');
});

test('a swaps table from before legs is dropped, and its cursors skip the old actions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'swaps-'));
  const file = join(dir, 'old.db');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE swaps (chain TEXT NOT NULL, id INTEGER NOT NULL, payout_tx TEXT NOT NULL, recipient TEXT NOT NULL,
      input TEXT NOT NULL, least TEXT, deadline INTEGER, outcome TEXT, paid TEXT, closed_tx TEXT,
      opened_at INTEGER NOT NULL, closed_at INTEGER, PRIMARY KEY (chain, id));
    INSERT INTO swaps VALUES ('xpr', 1, 'p', 'erin', '5.334172 USDT@wrap.alcor', NULL, NULL, 'swapped', '["2404.2597 XPR@eosio.token"]', 'c', 1, 2);
    INSERT INTO meta VALUES ('swaps:xpr', '100');`);
  old.close();
  const store = new Store(file);
  assert.equal(store.swapOf('xpr', 1), undefined);
  assert.ok(store.getNumber('swaps:xpr')! > 1_700_000_000);
  applySwapActions(store, 'xpr', [opened(1, 'payout1')]);
  assert.equal(store.swapOf('xpr', 1)?.back, 'alice');
});

test('an order that expired, its opened read again beside its closed', () => {
  const store = new Store(':memory:');
  applySwapActions(store, 'telos', [opened(3, 'payout3')]);
  applySwapActions(store, 'telos', [opened(3, 'payout3'), closed(3, 'refund3', 'expired', [USDC('100.000000')])]);
  const swap = swapOfPayout(store, 'payout3')!;
  assert.equal(swap.summary, 'refunded as 100.000000 USDC: no route paid the least by the deadline');
  assert.equal(swap.payoutTx, 'payout3');
});

test('the quote refuses what the front end got wrong, before asking anyone', async () => {
  const USDC_ETH = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
  const PEPE = '0x6982508145454ce325ddbe47a25d4ec3d2311933';
  const ask = (over: Partial<Parameters<typeof evmSwapQuote>[0]>) =>
    evmSwapQuote({ chain: 'mainnet', tokenIn: PEPE, tokenOut: USDC_ETH, amountIn: '1000', slippageBps: 50, ...over }, [USDC_ETH]);
  await assert.rejects(ask({ chain: 'solana' }), QuoteRefused);
  // Not deployed yet: nothing is quoted for a router that does not exist.
  await assert.rejects(ask({}), /AlcorRouter is not deployed on mainnet/);
});

test('reading the same actions again records nothing new', () => {
  const store = new Store(':memory:');
  assert.equal(applySwapActions(store, 'wax', [opened(5, 'payout5')]), 1);
  assert.equal(applySwapActions(store, 'wax', [opened(5, 'payout5')]), 0);
  assert.equal(applySwapActions(store, 'wax', [opened(5, 'payout5'), closed(5, 'exec5', 'swapped', [TLM('1.0000')])]), 1);
  assert.equal(applySwapActions(store, 'wax', [opened(5, 'payout5'), closed(5, 'exec5', 'swapped', [TLM('1.0000')])]), 0);
});

test('a hop ending in a swap is found by the swap\'s recipient, before and after the payout', () => {
  const store = new Store(':memory:');
  const XPR = '4057084141687023600';
  const WAX = '1181148696416462999';
  const dKey = `d:${WAX}:47`;
  store.upsertTransfer({
    key: dKey, direction: 'deposit', ref: 47, status: 'forwarded', account: 'hop.alcor', evm_address: 'dave',
    domain: WAX, amount: '5334172', memo: `${XPR}:route.alcor|${WAX}:dave|erin|2289.7711 XPR@eosio.token|1791845795`,
    src_block: 100, src_time: 1000, src_tx: 'twax',
  });
  // In flight: only the memo names the recipient — and the way back, which is followed by the swap's part now.
  assert.deepEqual(store.hopDeposits({ hop: 'hop.alcor', party: 'erin' }), [dKey]);
  assert.deepEqual(store.hopDeposits({ hop: 'hop.alcor', party: 'dave' }), [dKey]);
  store.putHop({
    id: 140, prev: null, deposit: dKey, quantity: '5.334172 USDT', to_domain: XPR, to_recipient: 'route.alcor',
    back_domain: WAX, back_recipient: 'dave', tx: 'tbind', block: 200, at: 1060,
  });
  store.upsertTransfer({
    key: 'w:140', direction: 'withdrawal', ref: 140, status: 'released', account: 'hop.alcor', evm_address: 'route.alcor',
    domain: XPR, amount: '5334172', src_block: 200, src_time: 1060, src_tx: 'tbind', dst_time: 1200, dst_tx: 'payout47',
  });
  applySwapActions(store, 'xpr', [action('opened', 'payout47', '2026-10-12T22:00:10.000', {
    id: 1, to: 'erin', back: 'erin', in: { quantity: '5.334172 USDT', contract: 'wrap.alcor' },
    least: { quantity: '2289.7711 XPR', contract: 'eosio.token' }, deadline: '2026-10-12T22:56:35',
  })]);
  assert.deepEqual(store.hopDeposits({ hop: 'hop.alcor', party: 'erin' }), [dKey]);
  assert.deepEqual(store.hopDeposits({ hop: 'hop.alcor', party: 'route.alcor' }), [dKey]);
  assert.deepEqual(store.hopDeposits({ hop: 'hop.alcor', party: 'ammprovide' }), [], 'not a prefix match');
});

// ---- an action in another shape (route.alcor's opened with a stale ABI, 2026-10-20) ----

/** `opened` of d:1:59 as a Hyperion host decoded it, with an ABI from before `to` and `back`. */
const STALE_OPENED = action('opened', '9a6ebc01', '2026-10-20T01:35:47.000', {
  id: '1',
  recipient: 'idmrotfnhxq.g',
  in: { quantity: '0.000000000000000000000000000004193181330767491439 x0d2cdc', contract: 'alkqegv4gks3a' },
  least: { quantity: '0.0000000000000000000000000000000004050479003054072929 ac006a0', contract: 'glm34i1pakva1' },
  deadline: '2011-07-15T12:45:26.000',
});

test('an action in a shape the contract does not declare is not stored', () => {
  const store = new Store(':memory:');
  assert.equal(wellFormedOpened(STALE_OPENED.data), false);
  assert.equal(applySwapActions(store, 'telos', [STALE_OPENED]), 0);
  assert.equal(store.swapOf('telos', 1), undefined);
});
