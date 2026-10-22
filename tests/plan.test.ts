/**
 * `/v1/swap/plan`: a journey that swaps at the source, on Telos or at the
 * destination, planned from `/v1/routes`, `/v1/chains` and quotes — the way
 * that delivers the most, or the reason none goes now.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PlanRefused, swapPlan, type ChainReader, type PlanChain, type PlanContext, type PlanRequest, type PlanRoute, type Quote, type Quoter,
} from '../services/indexer/plan.ts';

const NOW = 1_760_000_000;
const DEADLINE = NOW + 1800;
const USER = '0x5b38da6a701c568545dcfcb03fcb875f56beddc4';
const WAX = '1181148696416462999';
const XPR = '4057084141687023600';
const VAULTA = '12439917377594391589';

const chains: PlanChain[] = [
  { id: 'polygon', name: 'Polygon PoS', chainId: 137, contracts: { vault: '0x15bb' }, timing: { deposit: { seconds: 38 }, withdrawal: { seconds: 34 } } },
  { id: 'bsc', name: 'BNB Smart Chain', chainId: 56, contracts: { vault: '0x53f1' }, timing: { deposit: { seconds: 10 }, withdrawal: { seconds: 20 } } },
  { id: 'wax', name: 'WAX', kind: 'antelope', domain: WAX, contracts: { vault: 'bridge.alcor' }, timing: { deposit: { seconds: 50 }, withdrawal: { seconds: 107 } } },
  { id: 'xpr', name: 'XPR Network', kind: 'antelope', domain: XPR, contracts: { vault: 'bridge.alcor' }, timing: { deposit: { seconds: 178 }, withdrawal: { seconds: 15 } } },
  { id: 'vaulta', name: 'Vaulta', kind: 'antelope', domain: VAULTA, contracts: { vault: 'bridge.alcor' }, timing: { deposit: { seconds: 6 }, withdrawal: { seconds: 12 } } },
];

const route = (symbol: string, precision: number, from: string, to: string, min: string, max: string | null, how: PlanRoute['how'] = {}): PlanRoute => ({
  symbol, precision, from, to, via: from !== 'telos' && to !== 'telos' ? 'telos' : null, open: true, min, max, how,
});
/** Both ways between Telos and `chain`, and on an Antelope chain the token's contract there. */
const both = (symbol: string, precision: number, chain: string, min: string, contract?: string, token?: string): PlanRoute[] => [
  route(symbol, precision, chain, 'telos', min, null, contract ? { transfer: { contract } } : { deposit: { token: token ?? '0x0' } }),
  route(symbol, precision, 'telos', chain, min, null),
];
/** A hop's row, through Telos. */
const hop = (symbol: string, precision: number, from: string, to: string, min: string, contract?: string): PlanRoute =>
  route(symbol, precision, from, to, min, null, contract ? { transfer: { contract } } : { deposit: { token: '0x0' } });

const routes: PlanRoute[] = [
  ...both('POL', 8, 'polygon', '100000000', undefined, '0x0000000000000000000000000000000000000000'),
  route('BNB', 8, 'telos', 'bsc', '10000', '709070744'),
  ...both('POL', 8, 'wax', '100000000', 'wrap.alcor'),
  ...both('XPR', 4, 'xpr', '100000', 'eosio.token'),
  ...both('USDC', 6, 'xpr', '1000000', 'wrap.alcor'),
  ...both('USDC', 6, 'vaulta', '1000000', 'wrap.alcor'),
  ...both('A', 4, 'vaulta', '100000', 'core.vaulta'),
  ...both('USDT', 6, 'bsc', '1000000', undefined, '0x55d3'),
  ...both('USDT', 6, 'xpr', '1000000', 'wrap.alcor'),
  hop('USDC', 6, 'xpr', 'vaulta', '1000000', 'wrap.alcor'),
  hop('USDT', 6, 'xpr', 'bsc', '1000000', 'wrap.alcor'),
];

/** Every account exists but `nobody1`; tokens are at the precision their symbol has in `routes`, LOAN at 4. */
const read: ChainReader = {
  account: async (_chain, name) => name !== 'nobody1',
  precision: async (_chain, _contract, symbol) => (symbol === 'LOAN' ? 4 : routes.find((r) => r.symbol === symbol)?.precision ?? false),
};

/** A quote of `output` at `decimals`, its transfers spending `quantity`, the least at 99.5%. */
const swapOf = (output: string, decimals: number, pools: number[], transfers: Quote['transfers'] = [], priceImpact = '0.5'): Quote => ({
  output, decimals, priceImpact, pools, transfers,
});

/** Answers keyed `<chain> <input> <output>`; any other pair has no path. */
const quoter = (answers: Record<string, Quote | ((amount: string) => Quote)>): Quoter => async (chain, input, output, amount) => {
  const a = answers[`${chain} ${input} ${output}`];
  return typeof a === 'function' ? a(amount) : a ?? null;
};

const ctx = (quote: Quoter, over: Partial<PlanContext> = {}): PlanContext => ({
  routes, chains, settlement: { bridge: 'bridge.alcor', hop: 'hop.alcor' }, quote, read, now: NOW, ...over,
});
const ask = (over: Partial<PlanRequest> = {}): PlanRequest => ({
  from: 'polygon:POL', to: 'bsc:BNB', amount: '1233', recipient: USER, sender: USER,
  slippageBps: 50, deadlineSeconds: 1800, ...over,
});

const pool108 = quoter({ 'telos pol-wrap.alcor bnb-wrap.alcor': swapOf('0.15495725', 8, [108]) });

/** XPR on XPR Network: into USDC there (two legs), then USDC into A on Vaulta, or XPR into A on Telos. */
const xprToA = (xprUsdc = '2.780409', onTelos = '13.5499') => quoter({
  'xpr xpr-eosio.token usdc-wrap.alcor': swapOf(xprUsdc, 6, [15, 11708, 11710], [
    { tokenContract: 'eosio.token', to: 'swap.alcor', quantity: '826.1100 XPR', memo: 'swapexactin#15,11708#<account>#1.853606 USDC@wrap.alcor#0' },
    { tokenContract: 'eosio.token', to: 'swap.alcor', quantity: '406.8900 XPR', memo: 'swapexactin#11710#<account>#0.912969 USDC@wrap.alcor#0' },
  ], '0.34'),
  'vaulta usdc-wrap.alcor a-core.vaulta': swapOf('26.6841', 4, [728], [], '0.46'),
  'telos xpr-wrap.alcor a-wrap.alcor': swapOf(onTelos, 4, [109, 107], [], '10'),
});

test('Polygon POL to BSC BNB, swapped on Telos', async () => {
  const plan = await swapPlan(ask({ recipient: USER.toUpperCase().replace('0X', '0x') }), ctx(pool108));
  assert.equal(plan.possible, true);
  if (!plan.possible) return;
  assert.equal(plan.to.expected, '0.15495725');
  assert.equal(plan.to.least, '0.15418246', 'the quote less half a percent, rounded down');
  assert.equal(plan.memo, `56:${USER}|0.15418246 BNB@wrap.alcor|${DEADLINE}|137:${USER}`);
  assert.deepEqual(plan.sign, {
    kind: 'deposit', chain: 'polygon', vault: '0x15bb', token: '0x0000000000000000000000000000000000000000',
    telosTo: 'route.alcor', refundTo: USER, memo: plan.memo,
  });
  assert.equal(plan.swaps.length, 1);
  assert.deepEqual(plan.swaps[0].pools, [108]);
  assert.equal(plan.leftover, null);
  assert.equal(plan.release, 'user');
  assert.equal(plan.eta.seconds, 38 + 5 + 20);
  assert.equal(plan.from.raw, '123300000000');
});

test('from WAX the vault transfer carries route.alcor and the memo, the way back a WAX account', async () => {
  const plan = await swapPlan(ask({ from: 'wax:POL', sender: 'alice' }), ctx(pool108));
  assert.equal(plan.possible, true);
  if (!plan.possible) return;
  assert.equal(plan.back, `${WAX}:alice`);
  assert.deepEqual(plan.sign, {
    kind: 'actions', chain: 'wax',
    actions: [{
      account: 'wrap.alcor', name: 'transfer',
      data: { from: 'alice', to: 'bridge.alcor', quantity: '1233.00000000 POL', memo: `route.alcor:${plan.memo}` },
    }],
  });
});

test('XPR to Vaulta A: swapped into USDC on XPR, hopped, swapped into A on Vaulta — it beats the Telos pools', async () => {
  const plan = await swapPlan(ask({ from: 'xpr:XPR', to: 'vaulta:A', sender: 'erin', recipient: 'bob' }), ctx(xprToA()));
  assert.equal(plan.possible, true);
  if (!plan.possible) return;
  assert.equal(plan.to.expected, '26.6841');
  assert.equal(plan.to.least, '26.5506');
  assert.equal(plan.to.contract, 'core.vaulta');
  assert.deepEqual(plan.carried, { symbol: 'USDC', amount: '2.766575' }, 'what crosses is the least of the swap on XPR');
  assert.deepEqual(plan.leftover, { chain: 'xpr', asset: '0.013834 USDC', contract: 'wrap.alcor' });
  assert.deepEqual(plan.swaps.map((s) => [s.chain, s.by]), [['xpr', 'sender'], ['vaulta', 'route.alcor']]);
  assert.equal(plan.memo, `bob|26.5506 A@core.vaulta|${DEADLINE}`);
  assert.equal(plan.back, 'bob', 'never swapped, the USDC goes to the recipient on Vaulta');
  assert.equal(plan.sign.kind, 'actions');
  if (plan.sign.kind !== 'actions') return;
  assert.deepEqual(plan.sign.actions.map((a) => [a.account, a.data.to, a.data.quantity, a.data.memo]), [
    ['eosio.token', 'swap.alcor', '826.1100 XPR', 'swapexactin#15,11708#erin#1.853606 USDC@wrap.alcor#0'],
    ['eosio.token', 'swap.alcor', '406.8900 XPR', 'swapexactin#11710#erin#0.912969 USDC@wrap.alcor#0'],
    ['wrap.alcor', 'bridge.alcor', '2.766575 USDC', `hop.alcor:${VAULTA}:route.alcor|${XPR}:erin|${plan.memo}`],
  ]);
  assert.equal(plan.release, 'relayer');
  assert.equal(plan.eta.seconds, 0 + 178 + 12 + 5);
  assert.equal(plan.priceImpact, '0.80');
});

test('a better pool on Telos wins, and an amount under the hop\'s minimum leaves only Telos', async () => {
  const telosBetter = await swapPlan(ask({ from: 'xpr:XPR', to: 'vaulta:A', sender: 'erin', recipient: 'bob' }), ctx(xprToA(undefined, '30.0000')));
  assert.equal(telosBetter.possible, true);
  if (!telosBetter.possible) return;
  assert.deepEqual(telosBetter.swaps.map((s) => s.chain), ['telos']);
  assert.equal(telosBetter.memo, `${VAULTA}:bob|29.8500 A@wrap.alcor|${DEADLINE}|${XPR}:erin`);

  const smallQuotes = quoter({
    'xpr xpr-eosio.token usdc-wrap.alcor': swapOf('0.902', 6, [11710], [
      { tokenContract: 'eosio.token', to: 'swap.alcor', quantity: '400.0000 XPR', memo: 'swapexactin#11710#<account>#0.897490 USDC@wrap.alcor#0' },
    ]),
    'vaulta usdc-wrap.alcor a-core.vaulta': swapOf('8.7000', 4, [728]),
    'telos xpr-wrap.alcor a-wrap.alcor': swapOf('12.0000', 4, [109, 107]),
  });
  const small = await swapPlan(ask({ from: 'xpr:XPR', to: 'vaulta:A', amount: '400', sender: 'erin', recipient: 'bob' }), ctx(smallQuotes));
  assert.equal(small.possible, true);
  if (!small.possible) return;
  assert.deepEqual(small.swaps.map((s) => s.chain), ['telos'], 'under 1 USDC does not hop, 400 XPR crosses as it is');
});

test('from Telos: the user swaps there and withdraws, or withdraws to route.alcor at the destination', async () => {
  const quote = quoter({
    'telos usdc-wrap.alcor a-wrap.alcor': swapOf('19.6444', 4, [115, 107], [
      { tokenContract: 'wrap.alcor', to: 'swap.alcor', quantity: '2.000000 USDC', memo: 'swapexactin#115,107#<account>#19.5461 A@wrap.alcor#0' },
    ]),
    'vaulta usdc-wrap.alcor a-core.vaulta': swapOf('19.2900', 4, [728]),
  });
  const plan = await swapPlan(ask({ from: 'telos:USDC', to: 'vaulta:A', amount: '2', sender: 'alice', recipient: 'bob' }), ctx(quote));
  assert.equal(plan.possible, true);
  if (!plan.possible || plan.sign.kind !== 'actions') return;
  assert.deepEqual(plan.swaps.map((s) => [s.chain, s.by]), [['telos', 'sender']]);
  assert.deepEqual(plan.sign.actions.map((a) => [a.account, a.data.to, a.data.quantity, a.data.memo]), [
    ['wrap.alcor', 'swap.alcor', '2.000000 USDC', 'swapexactin#115,107#alice#19.5461 A@wrap.alcor#0'],
    ['wrap.alcor', 'bridge.alcor', '19.5461 A', `${VAULTA}:bob`],
  ]);
  assert.equal(plan.to.least, '19.5461');

  const vaultaBetter = quoter({ 'vaulta usdc-wrap.alcor a-core.vaulta': swapOf('26.0000', 4, [728]) });
  const far = await swapPlan(ask({ from: 'telos:USDC', to: 'vaulta:A', amount: '2', sender: 'alice', recipient: 'bob' }), ctx(vaultaBetter));
  assert.equal(far.possible, true);
  if (!far.possible || far.sign.kind !== 'actions') return;
  assert.deepEqual(far.sign.actions.map((a) => [a.data.to, a.data.quantity, a.data.memo]), [
    ['bridge.alcor', '2.000000 USDC', `${VAULTA}:route.alcor:0:bob|25.8700 A@core.vaulta|${DEADLINE}`],
  ]);
});

test('swapped at the source only: XPR into USDT on XPR, hopped to BSC', async () => {
  const quote = quoter({
    'xpr xpr-eosio.token usdt-wrap.alcor': swapOf('2.79', 6, [11711], [
      { tokenContract: 'eosio.token', to: 'swap.alcor', quantity: '1233.0000 XPR', memo: 'swapexactin#11711#<account>#2.776050 USDT@wrap.alcor#0' },
    ]),
  });
  const plan = await swapPlan(ask({ from: 'xpr:XPR', to: 'bsc:USDT', sender: 'erin' }), ctx(quote));
  assert.equal(plan.possible, true);
  if (!plan.possible || plan.sign.kind !== 'actions') return;
  assert.equal(plan.memo, null);
  assert.equal(plan.to.least, '2.77605');
  assert.equal(plan.sign.actions[1].data.memo, `hop.alcor:56:${USER}|${XPR}:erin`);
  assert.equal(plan.release, 'user');
});

test('a courier fee on the last leg to an EVM chain: in its memo, out of what the recipient gets', async () => {
  const swapped = await swapPlan(ask({ courierFee: '250000' }), ctx(pool108));
  assert.equal(swapped.possible, true);
  if (!swapped.possible) return;
  assert.equal(swapped.memo, `56:${USER}:250000|0.15418246 BNB@wrap.alcor|${DEADLINE}|137:${USER}`, 'the swap on Telos delivers with it');
  assert.equal(swapped.to.expected, '0.15245725');
  assert.equal(swapped.to.least, '0.15168246');
  assert.equal(swapped.courierFee, '0.0025');
  assert.equal(swapped.release, 'courier');

  const quote = quoter({
    'xpr xpr-eosio.token usdt-wrap.alcor': swapOf('2.79', 6, [11711], [
      { tokenContract: 'eosio.token', to: 'swap.alcor', quantity: '1233.0000 XPR', memo: 'swapexactin#11711#<account>#2.776050 USDT@wrap.alcor#0' },
    ]),
  });
  const hopped = await swapPlan(ask({ from: 'xpr:XPR', to: 'bsc:USDT', sender: 'erin', courierFee: '30000' }), ctx(quote));
  assert.equal(hopped.possible, true);
  if (!hopped.possible || hopped.sign.kind !== 'actions') return;
  assert.equal(hopped.sign.actions[1].data.memo, `hop.alcor:56:${USER}:30000|${XPR}:erin`, 'the hop\'s leg out carries it, its way back none');
  assert.equal(hopped.to.least, '2.74605');
  assert.equal(hopped.release, 'courier');

  const zero = await swapPlan(ask({ courierFee: '0' }), ctx(pool108));
  assert.equal(zero.possible && zero.release, 'user', 'a fee of 0 is no fee');
  assert.equal(zero.possible && zero.memo, `56:${USER}|0.15418246 BNB@wrap.alcor|${DEADLINE}|137:${USER}`);

  const atFloor = await swapPlan(ask({ from: 'xpr:XPR', to: 'bsc:USDT', sender: 'erin', courierFee: '1776050' }), ctx(quote));
  assert.equal(atFloor.possible && atFloor.to.least, '1', 'the recipient gets BSC\'s minimum exactly');
  const under = await swapPlan(ask({ from: 'xpr:XPR', to: 'bsc:USDT', sender: 'erin', courierFee: '1776051' }), ctx(quote));
  assert.equal(under.possible, false, 'a unit more and the hop does not go');
  const underOnTelos = await swapPlan(ask({ courierFee: '15408247' }), ctx(pool108));
  assert.match((underOnTelos as { reason: string }).reason, /least out less the courier's fee, 0.00009999 BNB, is under/);

  await assert.rejects(swapPlan(ask({ from: 'xpr:XPR', to: 'vaulta:A', sender: 'erin', recipient: 'bob', courierFee: '1' }), ctx(xprToA())), /courierFee is for a last leg to an EVM chain/);
  await assert.rejects(swapPlan(ask({ courierFee: '0.5' }), ctx(pool108)), /whole number of canonical units/);
});

test('any token on an Antelope chain, named with its contract', async () => {
  const quote = quoter({
    'xpr loan-loan.token usdc-wrap.alcor': swapOf('5', 6, [9], [
      { tokenContract: 'loan.token', to: 'swap.alcor', quantity: '100.0000 LOAN', memo: 'swapexactin#9#<account>#4.975000 USDC@wrap.alcor#0' },
    ]),
    'vaulta usdc-wrap.alcor a-core.vaulta': swapOf('48', 4, [728]),
  });
  const plan = await swapPlan(ask({ from: 'xpr:LOAN@loan.token', to: 'vaulta:A', amount: '100', sender: 'erin', recipient: 'bob' }), ctx(quote));
  assert.equal(plan.possible, true);
  await assert.rejects(swapPlan(ask({ from: 'xpr:LOAN', to: 'vaulta:A', amount: '100', sender: 'erin', recipient: 'bob' }), ctx(quote)), /name its contract/);
});

test('the swap at the source only goes to venues the plan knows, and must spend all of the input', async () => {
  const stranger = quoter({
    'xpr xpr-eosio.token usdc-wrap.alcor': swapOf('2.78', 6, [1], [
      { tokenContract: 'eosio.token', to: 'thief', quantity: '1233.0000 XPR', memo: 'swapexactin#1#<account>#2.766100 USDC@wrap.alcor#0' },
    ]),
    'vaulta usdc-wrap.alcor a-core.vaulta': swapOf('26', 4, [728]),
  });
  const r = ask({ from: 'xpr:XPR', to: 'vaulta:A', sender: 'erin', recipient: 'bob' });
  assert.match((await swapPlan(r, ctx(stranger)) as { reason: string }).reason, /no pool path|not a venue/);
  const short = quoter({
    'xpr xpr-eosio.token usdc-wrap.alcor': swapOf('2.78', 6, [1], [
      { tokenContract: 'eosio.token', to: 'swap.alcor', quantity: '1000.0000 XPR', memo: 'swapexactin#1#<account>#2.766100 USDC@wrap.alcor#0' },
    ]),
  });
  assert.equal((await swapPlan(r, ctx(short))).possible, false);
});

test('what cannot go now says why', async () => {
  assert.deepEqual(await swapPlan(ask(), ctx(quoter({}))), { possible: false, reason: 'no pool path from POL to BNB on Telos' });
  assert.match((await swapPlan(ask({ amount: '0.5' }), ctx(pool108)) as { reason: string }).reason, /at least 1 POL/);
  const tiny = quoter({ 'telos pol-wrap.alcor bnb-wrap.alcor': swapOf('0.00005', 8, [108]) });
  assert.match((await swapPlan(ask(), ctx(tiny)) as { reason: string }).reason, /under BNB Smart Chain's minimum/);
  const huge = quoter({ 'telos pol-wrap.alcor bnb-wrap.alcor': swapOf('9.5', 8, [108]) });
  assert.match((await swapPlan(ask(), ctx(huge)) as { reason: string }).reason, /at most 7.09070744 BNB/);
  assert.match((await swapPlan(ask({ to: 'bsc:WAX' }), ctx(pool108)) as { reason: string }).reason, /no way from POL on Polygon PoS to WAX/);
  assert.match((await swapPlan(ask({ to: 'polygon:POL' }), ctx(pool108)) as { reason: string }).reason, /swap on Alcor there|plain crossing/);
  assert.match((await swapPlan(ask({ from: 'xpr:USDC', to: 'vaulta:USDC', sender: 'alice', recipient: 'bob' }), ctx(pool108)) as { reason: string }).reason, /plain crossing or a hop/);
  const closed = routes.map((x) => (x.symbol === 'BNB' ? { ...x, open: false, reason: 'BNB Smart Chain pays no BNB withdrawals now' } : x));
  assert.deepEqual(await swapPlan(ask(), ctx(pool108, { routes: closed })), { possible: false, reason: 'BNB Smart Chain pays no BNB withdrawals now' });
});

test('Alcor failing on every way is an error, on some ways it is not', async () => {
  const down: Quoter = async () => { throw new Error('getRoute: 502'); };
  await assert.rejects(swapPlan(ask(), ctx(down)), /502/);
  const vaultaDown: Quoter = async (chain, ...rest) => {
    if (chain === 'vaulta') throw new Error('getRoute: 502');
    return xprToA()(chain, ...rest);
  };
  const plan = await swapPlan(ask({ from: 'xpr:XPR', to: 'vaulta:A', sender: 'erin', recipient: 'bob' }), ctx(vaultaDown));
  assert.equal(plan.possible, true);
  if (plan.possible) assert.deepEqual(plan.swaps.map((s) => s.chain), ['telos']);
});

test('a request the front end got wrong is refused', async () => {
  await assert.rejects(swapPlan(ask({ from: 'POL' }), ctx(pool108)), PlanRefused);
  await assert.rejects(swapPlan(ask({ recipient: 'alice' }), ctx(pool108)), /0x address/);
  await assert.rejects(swapPlan(ask({ recipient: `0x${'0'.repeat(40)}` }), ctx(pool108)), /non-zero/);
  await assert.rejects(swapPlan(ask({ amount: '1.123456789' }), ctx(pool108)), /at most 8 places/);
  await assert.rejects(swapPlan(ask({ slippageBps: 0 }), ctx(pool108)), /slippageBps/);
  await assert.rejects(swapPlan(ask({ to: 'solana:SOL' }), ctx(pool108)), /no chain solana/);
  await assert.rejects(swapPlan(ask({ to: 'bsc:BNB@wrap.alcor' }), ctx(pool108)), /symbol alone/);
});

test('the recipient must take the delivery: an account that exists, not the bridge\'s own', async () => {
  const withBnb = [...routes, ...both('BNB', 8, 'wax', '10000', 'wrap.alcor')];
  const toWax = (recipient: string, lookup = read) =>
    swapPlan(ask({ to: 'wax:BNB', recipient }), ctx(pool108, { routes: withBnb, read: lookup }));
  assert.equal((await toWax('alice')).possible, true);
  assert.deepEqual(await toWax('nobody1'), { possible: false, reason: 'nobody1 does not exist on WAX: create the account first' });
  assert.match((await toWax('bridge.alcor') as { reason: string }).reason, /bridge's own account on WAX/);
  assert.match((await toWax('route.alcor') as { reason: string }).reason, /bridge's own account on WAX/);
  assert.match((await toWax('wrap.alcor') as { reason: string }).reason, /bridge's own account on WAX/);
  assert.deepEqual(await toWax('alice', { ...read, account: async () => null }), { possible: false, reason: 'cannot check now that alice exists on WAX' });

  const vault = '0x53f1000000000000000000000000000000000001';
  const bscVault = chains.map((c) => (c.id === 'bsc' ? { ...c, contracts: { vault } } : c));
  const toVault = await swapPlan(ask({ recipient: vault.toUpperCase().replace('0X', '0x') }), ctx(pool108, { chains: bscVault }));
  assert.match((toVault as { reason: string }).reason, /bridge's own account on BNB Smart Chain/);
});

const SUI = '3856007665771390095';
const NEAR = '14338890689662875897';
const SUI_USER = `0x${'5a'.repeat(32)}`;
const SUI_USDC = '0xdba3::usdc::USDC';
/** sha256("alice.near"), as the NEAR vault spells the account on Telos. */
const ALICE_NEAR = '0x2dd5dda540767b3a1aa33544bcba38042f4df6de9bddb46798b29481c842c558';
const thirtyTwo: PlanChain[] = [
  ...chains,
  { id: 'sui', name: 'Sui', kind: 'sui', domain: SUI, contracts: { vault: '0x9ed7' }, timing: { deposit: { seconds: 20 }, withdrawal: { seconds: 30 } } },
  { id: 'near', name: 'NEAR', kind: 'near', domain: NEAR, contracts: { vault: 'alcor-bridge.near' }, timing: { deposit: { seconds: 8 }, withdrawal: { seconds: 25 } } },
];
const thirtyTwoRoutes: PlanRoute[] = [
  ...routes,
  route('USDC', 6, 'sui', 'telos', '1000000', null, { deposit: { token: null, coinType: SUI_USDC } }),
  route('USDC', 6, 'telos', 'sui', '1000000', null),
  route('USDT', 6, 'near', 'telos', '1000000', null, { deposit: { token: null, nearToken: 'usdt.tether-token.near' } }),
  route('USDT', 6, 'telos', 'near', '1000000', null),
  ...both('USDC', 6, 'wax', '1000000', 'wrap.alcor'),
  hop('USDC', 6, 'sui', 'xpr', '1000000'),
];

test('from Sui: USDC hopped to XPR and swapped into XPR there; the deposit names the coin type', async () => {
  const quote = quoter({ 'xpr usdc-wrap.alcor xpr-eosio.token': swapOf('3600.0000', 4, [11710]) });
  const plan = await swapPlan(ask({ from: 'sui:USDC', to: 'xpr:XPR', amount: '10', sender: SUI_USER.toUpperCase().replace('0X', '0x'), recipient: 'bob' }),
    ctx(quote, { chains: thirtyTwo, routes: thirtyTwoRoutes }));
  assert.equal(plan.possible, true);
  if (!plan.possible) return;
  assert.equal(plan.memo, `bob|3582.0000 XPR@eosio.token|${DEADLINE}`);
  assert.deepEqual(plan.sign, {
    kind: 'deposit', chain: 'sui', vault: '0x9ed7', token: null, coinType: SUI_USDC,
    telosTo: 'hop.alcor', refundTo: SUI_USER, memo: `${XPR}:route.alcor|${SUI}:${SUI_USER}|${plan.memo}`,
  });
  assert.equal(plan.release, 'relayer');
});

test('to NEAR: WAX USDC swapped into USDT on Telos, delivered to the sha256 of the account id', async () => {
  const quote = quoter({ 'telos usdc-wrap.alcor usdt-wrap.alcor': swapOf('9.990000', 6, [118]) });
  const plan = await swapPlan(ask({ from: 'wax:USDC', to: 'near:USDT', amount: '10', sender: 'alice', recipient: 'alice.near' }),
    ctx(quote, { chains: thirtyTwo, routes: thirtyTwoRoutes }));
  assert.equal(plan.possible, true);
  if (!plan.possible) return;
  assert.equal(plan.memo, `${NEAR}:${ALICE_NEAR}|9.940050 USDT@wrap.alcor|${DEADLINE}|${WAX}:alice`);
  assert.equal(plan.to.recipient, 'alice.near');
  assert.equal(plan.release, 'user');

  const nowhere = await swapPlan(ask({ from: 'wax:USDC', to: 'near:USDT', amount: '10', sender: 'alice', recipient: 'nobody1' }),
    ctx(quote, { chains: thirtyTwo, routes: thirtyTwoRoutes }));
  assert.deepEqual(nowhere, { possible: false, reason: 'nobody1 does not exist on NEAR: create the account first' });
  await assert.rejects(swapPlan(ask({ from: 'wax:USDC', to: 'near:USDT', amount: '10', sender: 'alice', recipient: 'Alice.NEAR' }),
    ctx(quote, { chains: thirtyTwo, routes: thirtyTwoRoutes })), /NEAR account id/);
  await assert.rejects(swapPlan(ask({ from: 'sui:USDC', to: 'xpr:XPR', amount: '10', sender: `0x${'0'.repeat(64)}`, recipient: 'bob' }),
    ctx(quote, { chains: thirtyTwo, routes: thirtyTwoRoutes })), /non-zero 0x address/);
});
