/**
 * Hops through bridgehop: reading `bind` out of the stream, putting a
 * journey's legs back together, and listing the pairs of chains a hop joins.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ABI, Serializer } from '@wharfkit/antelope';

import { readBridgeEvents } from '../services/indexer/bridgeActions.ts';
import { Store, depositKey, withdrawalKey } from '../services/indexer/db.ts';
import { hopLink, journey, journeyOf, parseHopMemo, routesBetween } from '../services/indexer/hops.ts';
import type { ProgressContext } from '../services/indexer/progress.ts';
import { antelopeDepositEta, antelopeWithdrawalEta } from '../src/chains/eta.ts';
import { antelopeById } from '../src/chains/antelope.ts';

const waxChain = antelopeById('wax')!;
import type { ActionTrace } from '../src/savanna/traces.ts';

const BRIDGE = 'bridge.alcor';
const HOP = 'hop.alcor';
const WAX = '1181148696416462999';

const abi = ABI.from({
  version: 'eosio::abi/1.2',
  structs: [
    {
      name: 'bind',
      base: '',
      fields: [
        { name: 'id', type: 'uint64' },
        { name: 'prev', type: 'uint64' },
        { name: 'quantity', type: 'asset' },
        { name: 'to_domain', type: 'uint64' },
        { name: 'to', type: 'string' },
        { name: 'back_domain', type: 'uint64' },
        { name: 'back', type: 'string' },
      ],
    },
    { name: 'forward', base: '', fields: [{ name: 'domain', type: 'uint64' }, { name: 'nonce', type: 'uint64' }] },
    {
      name: 'fill',
      base: '',
      fields: [
        { name: 'solver', type: 'name' },
        { name: 'domain', type: 'uint64' },
        { name: 'nonce', type: 'uint64' },
        { name: 'beneficiary', type: 'name' },
      ],
    },
  ],
  actions: ['bind', 'forward', 'fill'].map((name) => ({ name, type: name, ricardian_contract: '' })),
});

function trace(account: string, name: string, data: object, trxId: string, receiver = account): ActionTrace {
  return {
    receiver,
    account,
    name,
    data: Serializer.encode({ object: data, type: name, abi }).hexString,
    trxId,
  } as ActionTrace;
}

const bind = { id: 7, prev: 0, quantity: '5.000000 USDC', to_domain: WAX, to: 'alice.wam', back_domain: 1, back: '0x' + 'ab'.repeat(20) };

test('bind is read from the hop account only, with a forward or fill beside it', () => {
  const events = readBridgeEvents(abi, BRIDGE, [
    trace(BRIDGE, 'forward', { domain: 1, nonce: 3 }, 'tx1'),
    trace(HOP, 'bind', bind, 'tx1'),
    trace(HOP, 'bind', bind, 'tx1', 'someone.else'), // a notification, not the action
    trace('other.acct', 'bind', bind, 'tx1', HOP), // somebody else's bind
    trace(BRIDGE, 'fill', { solver: 'solver', domain: WAX, nonce: 4, beneficiary: HOP }, 'tx2'),
  ], HOP);
  assert.deepEqual(events.map((e) => e.kind), ['forward', 'hop', 'fill']);
  assert.deepEqual(events[1], {
    kind: 'hop', id: 7, prev: 0, quantity: '5.000000 USDC', toDomain: WAX, to: 'alice.wam',
    backDomain: '1', back: bind.back, trxId: 'tx1',
  });
  assert.deepEqual(events[2], { kind: 'fill', domain: WAX, nonce: 4, beneficiary: HOP, trxId: 'tx2' });
});

test('with no hop account configured, bind is not read at all', () => {
  const events = readBridgeEvents(abi, BRIDGE, [trace(HOP, 'bind', bind, 'tx1')]);
  assert.deepEqual(events, []);
});

test('the hop memo is read for display, and only in its one shape', () => {
  assert.deepEqual(parseHopMemo(`${WAX}:alice.wam|1:0xabc`), { to: [WAX, 'alice.wam'], back: ['1', '0xabc'] });
  assert.equal(parseHopMemo('alice.wam'), undefined);
  assert.equal(parseHopMemo(`${WAX}:alice.wam`), undefined);
  assert.equal(parseHopMemo(`${WAX}:a|1:b:5`), undefined, 'the way back carries no fee');
  assert.equal(parseHopMemo(`${WAX}:a:5:6|1:b`), undefined);
  assert.equal(parseHopMemo(null), undefined);
});

test('a courier fee on the leg out is no part of where it goes', () => {
  assert.deepEqual(parseHopMemo(`56:0xabc:250000|${WAX}:alice`), { to: ['56', '0xabc'], back: [WAX, 'alice'] });
});

test('a hop memo with a memo for the far side reads the same two legs', () => {
  assert.deepEqual(parseHopMemo(`${WAX}:al|1:0xabc|vasya.al:PUB_K1_x:PUB_WA_y`), {
    to: [WAX, 'al'],
    back: ['1', '0xabc'],
  });
});

/** A deposit from Ethereum to the hop, carried on to WAX as withdrawal 7. */
function ethToWax() {
  const store = new Store(':memory:');
  const dKey = depositKey(1, 3);
  const user = '0x' + 'ab'.repeat(20);
  store.upsertTransfer({
    key: dKey, direction: 'deposit', ref: 3, status: 'seen', account: HOP, evm_address: user,
    domain: '1', amount: '5000000', memo: `${WAX}:alice.wam|1:${user}`, src_block: 100, src_time: 1000,
  });
  return { store, dKey, user };
}

const chainOf = (d: string | null) => (d === '1' ? 'mainnet' : d === WAX ? 'wax' : null);
const same = <T>(row: T) => row;
/** Ethereum at block 110, routes with a fast path up to 5,000 USDC at 12 confirmations, the measured timings. */
const ctx: ProgressContext = {
  now: 2050,
  evmHead: (d) => (d === '1' ? 110 : undefined),
  route: () => ({ id: 1, optimisticMax: 5_000_000_000n, minConfirmations: 12, depositsOpen: true }),
  chainName: (d) => (d === '1' ? 'Ethereum' : d === WAX ? 'WAX' : 'the far chain'),
  isAntelope: (d) => d === WAX,
  depositEta: (d) => (d === WAX ? antelopeDepositEta(waxChain) : null),
  withdrawalEta: (d) => (d === WAX ? antelopeWithdrawalEta(waxChain) : null),
  hold: () => null,
};

test('a journey goes arriving, sending, delivered', () => {
  const { store, dKey, user } = ethToWax();
  let j = journey(store, dKey, same, chainOf, HOP, ctx)!;
  assert.equal(j.status, 'arriving');
  // 10 of 12 confirmations (head 110 over block 100, as the ledger counts
  // them): half of the deposit's 75%, and the WAX leg still to come.
  assert.deepEqual(j.progress, {
    stage: '10 of 12 confirmations on Ethereum', percent: 38,
    etaSeconds: 2 * 12 + 5 + antelopeWithdrawalEta(waxChain).seconds, exact: true, waitingOn: 'bridge',
  });
  // Before the hop, its ends come from the memo.
  assert.deepEqual(j.to, { domain: WAX, recipient: 'alice.wam', chain: 'wax' });
  assert.deepEqual(j.back, { domain: '1', recipient: user, chain: 'mainnet' });

  store.putHop({
    id: 7, prev: null, deposit: dKey, quantity: '5.000000 USDC', to_domain: WAX, to_recipient: 'alice.wam',
    back_domain: '1', back_recipient: user, tx: 'tx1', block: 200, at: 2000,
  });
  store.upsertTransfer({ key: withdrawalKey(7), direction: 'withdrawal', ref: 7, status: 'burned', account: HOP, evm_address: 'alice.wam', domain: WAX, src_block: 200, src_time: 2000 });
  j = journey(store, dKey, same, chainOf, HOP, ctx)!;
  assert.equal(j.status, 'sending');
  assert.equal(j.progress.stage, 'WAX release by the relayer');
  assert.ok(j.progress.percent > 50 && j.progress.percent < 100);
  assert.equal(j.legs.length, 1);
  assert.equal(j.recover, null);

  store.upsertTransfer({ key: withdrawalKey(7), direction: 'withdrawal', ref: 7, status: 'released', src_block: 200, src_time: 2000 });
  const delivered = journey(store, dKey, same, chainOf, HOP, ctx)!;
  assert.equal(delivered.status, 'delivered');
  assert.deepEqual(delivered.progress, { stage: 'delivered on WAX', percent: 100, etaSeconds: null, exact: true, waitingOn: null });

  // Each leg says what it is part of.
  assert.deepEqual(hopLink(store, store.getTransfer(dKey)!, chainOf), {
    journey: dKey, next: 'w:7',
    to: { domain: WAX, recipient: 'alice.wam', chain: 'wax' },
    back: { domain: '1', recipient: user, chain: 'mainnet' },
  });
  assert.equal(hopLink(store, store.getTransfer(withdrawalKey(7))!, chainOf)!.from, dKey);
});

test('a voided hop is returning with a recover to push, then returned', () => {
  const { store, dKey, user } = ethToWax();
  store.putHop({
    id: 7, prev: null, deposit: dKey, quantity: '5.000000 USDC', to_domain: WAX, to_recipient: 'nobody.wam',
    back_domain: '1', back_recipient: user, tx: 'tx1', block: 200, at: 2000,
  });
  store.upsertTransfer({ key: withdrawalKey(7), direction: 'withdrawal', ref: 7, status: 'refunded', src_block: 200, src_time: 2000 });
  let j = journey(store, dKey, same, chainOf, HOP, ctx)!;
  assert.equal(j.status, 'returning');
  assert.deepEqual(j.recover, { account: HOP, name: 'recover', data: { id: '7' } });
  assert.deepEqual(store.awaitingRecover().map((h) => h.id), [7]);

  // Recovered: withdrawal 9 sends it to the way back.
  store.putHop({
    id: 9, prev: 7, deposit: null, quantity: '5.000000 USDC', to_domain: '1', to_recipient: user,
    back_domain: '1', back_recipient: user, tx: 'tx2', block: 300, at: 3000,
  });
  store.upsertTransfer({ key: withdrawalKey(9), direction: 'withdrawal', ref: 9, status: 'burned', src_block: 300, src_time: 3000 });
  j = journey(store, dKey, same, chainOf, HOP, ctx)!;
  assert.equal(j.status, 'returning');
  assert.equal(j.recover, null);
  assert.deepEqual(store.awaitingRecover(), []);

  assert.deepEqual(j.legs.map((l) => [l.key, l.returning]), [['w:7', false], ['w:9', true]]);
  // The way back still knows the journey it belongs to.
  assert.equal(hopLink(store, store.getTransfer(withdrawalKey(9))!, chainOf)!.journey, dKey);

  store.upsertTransfer({ key: withdrawalKey(9), direction: 'withdrawal', ref: 9, status: 'released', src_block: 300, src_time: 3000 });
  assert.equal(journey(store, dKey, same, chainOf, HOP, ctx)!.status, 'returned');
});

test('a way back voided too waits again, and says it is a way back', () => {
  const { store, dKey, user } = ethToWax();
  store.putHop({
    id: 7, prev: null, deposit: dKey, quantity: '5.000000 USDC', to_domain: WAX, to_recipient: 'nobody.wam',
    back_domain: '1', back_recipient: user, tx: 'tx1', block: 200, at: 2000,
  });
  store.putHop({
    id: 9, prev: 7, deposit: null, quantity: '5.000000 USDC', to_domain: '1', to_recipient: user,
    back_domain: '1', back_recipient: user, tx: 'tx2', block: 300, at: 3000,
  });
  for (const id of [7, 9]) {
    store.upsertTransfer({ key: withdrawalKey(id), direction: 'withdrawal', ref: id, status: 'refunded', src_block: 300, src_time: 3000 });
  }
  assert.deepEqual(store.awaitingRecover().map((h) => [h.id, h.prev]), [[9, 7]]);
  assert.equal(journeyOf(store, store.getHop(9)!), dKey);
  const j = journey(store, dKey, same, chainOf, HOP, ctx)!;
  assert.equal(j.legs.at(-1)!.returning, true);
  assert.deepEqual(j.recover, { account: HOP, name: 'recover', data: { id: '9' } });
});

test('a deposit the hop refused is bounced', () => {
  const { store, dKey } = ethToWax();
  store.upsertTransfer({ key: dKey, direction: 'deposit', ref: 3, status: 'bounced', src_block: 100, src_time: 1000 });
  assert.equal(journey(store, dKey, same, chainOf, HOP, ctx)!.status, 'bounced');
});

test('a journey is listed from its deposit, before the hop opens, by either end of its memo', () => {
  const { store, dKey, user } = ethToWax();
  assert.deepEqual(store.hopDeposits({ hop: HOP }), [dKey]);
  assert.deepEqual(store.hopDeposits({ hop: HOP, party: 'alice.wam' }), [dKey]);
  assert.deepEqual(store.hopDeposits({ hop: HOP, party: user }), [dKey]);
  assert.deepEqual(store.hopDeposits({ hop: HOP, party: 'alice' }), []); // not a prefix match
  assert.deepEqual(store.hopDeposits({ hop: 'someone.else' }), []);
});

test('journeys are found by any party to them', () => {
  const { store, dKey, user } = ethToWax();
  store.putHop({
    id: 7, prev: null, deposit: dKey, quantity: '5.000000 USDC', to_domain: WAX, to_recipient: 'alice.wam',
    back_domain: '1', back_recipient: user, tx: 'tx1', block: 200, at: 2000,
  });
  assert.deepEqual(store.hopDeposits({ hop: HOP, party: 'alice.wam' }), [dKey]);
  assert.deepEqual(store.hopDeposits({ hop: HOP, party: user.toUpperCase().replace('0X', '0x') }), [dKey]);
  assert.deepEqual(store.hopDeposits({ hop: HOP, party: 'bob' }), []);
  // A replayed bind changes nothing.
  store.putHop({
    id: 7, prev: null, deposit: null, quantity: '5.000000 USDC', to_domain: WAX, to_recipient: 'alice.wam',
    back_domain: '1', back_recipient: user, tx: 'tx1', block: 200, at: 2000,
  });
  assert.equal(store.getHop(7)!.deposit, dKey);
});

const usdc = (over: object = {}) => ({
  symbol: 'USDC', precision: 6, deposits: true, withdrawals: true,
  minDeposit: '1000000', minWithdrawal: '1000000', maxWithdrawal: '2000000000',
  withdrawableNow: '500000000', depositableNow: '9000000000', withdrawMemo: '1:0x<recipient>',
  ...over,
});
const eth = { id: 'mainnet', name: 'Ethereum', chainId: 1, active: { deposits: true, withdrawals: true }, routes: [usdc({ token: '0xa0b8' })] };
const wax = {
  id: 'wax', name: 'WAX', kind: 'antelope', domain: WAX, active: { deposits: true, withdrawals: true },
  routes: [usdc({ minDeposit: '2000000', minWithdrawal: '2000000', withdrawableNow: '8000000000', depositableNow: '300000000', withdrawMemo: `${WAX}:<account>`, depositMemo: '<telos account>[:<note>]', antelopeToken: { contract: 'wrap.alcor', symbol: 'USDC', precision: 6 } })],
};
const telos = { id: 'telos-production', name: 'Telos' };

test('routes: both directions to Telos, and a hop each way between the chains', () => {
  const all = routesBetween([eth, wax], telos, { account: HOP, deployed: true }) as any[];
  assert.deepEqual(
    all.map((r) => `${r.from}>${r.to}${r.via ? ' via ' + r.via : ''}`),
    [
      'mainnet>telos-production', 'telos-production>mainnet', 'mainnet>wax via telos-production',
      'wax>telos-production', 'telos-production>wax', 'wax>mainnet via telos-production',
    ],
  );
  const ethToWax = all[2];
  assert.equal(ethToWax.open, true);
  // The largest floor of the routes a hop is checked against; the smallest ceiling of
  // where it goes and what Ethereum may still take — not the way back's 2,000.
  assert.equal(ethToWax.min, '2000000');
  assert.equal(ethToWax.max, '8000000000');
  assert.deepEqual(ethToWax.how, { deposit: { token: '0xa0b8', telosTo: HOP, memo: `${WAX}:<account>|1:<your address>` } });

  const waxToEth = all[5];
  assert.equal(waxToEth.max, '300000000');
  assert.deepEqual(waxToEth.how, { transfer: { contract: 'wrap.alcor', memo: `${HOP}:1:0x<address>|${WAX}:<your account>` } });
});

test('routes: a hop says why it is closed', () => {
  const closedWax = { ...wax, active: { deposits: true, withdrawals: false } };
  const hops = (routesBetween([eth, closedWax], telos, { account: HOP, deployed: false }) as any[]).filter((r) => r.via);
  assert.equal(hops[0].open, false);
  assert.equal(hops[0].reason, 'hop.alcor runs no code; WAX pays no USDC withdrawals now');
  const none = (routesBetween([eth, wax], telos, { account: undefined, deployed: false }) as any[]).filter((r) => r.via);
  assert.equal(none[0].reason, 'no hop contract on this ledger');
});

test("routes: a chain that is shut says the chain's own reason", () => {
  const catchingUp = { ...wax, active: { deposits: false, withdrawals: true, reason: 'the WAX blockroot keeper is catching up' } };
  const all = routesBetween([eth, catchingUp], telos, { account: HOP, deployed: true }) as any[];
  const home = all.find((r) => r.from === 'wax' && r.to === 'telos-production');
  assert.deepEqual([home.open, home.reason], [false, 'WAX takes no USDC deposits now: the WAX blockroot keeper is catching up']);
  assert.equal(all.find((r) => r.from === 'wax' && r.to === 'mainnet').reason, home.reason);
  // Withdrawals to WAX are untouched.
  assert.equal(all.find((r) => r.from === 'telos-production' && r.to === 'wax').open, true);
});

test('routes: open flags with nothing left under the bound are closed, saying which bound', () => {
  const drained = { ...eth, routes: [usdc({ token: '0xa0b8', kind: 'backing', available: '0', withdrawableNow: '0' })] };
  const all = routesBetween([drained, wax], telos, { account: HOP, deployed: true }) as any[];
  const out = all.find((r) => r.from === 'telos-production' && r.to === 'mainnet');
  assert.deepEqual([out.open, out.reason], [false, 'the Ethereum vault has no USDC to pay out yet']);
  const waxToEth = all.find((r) => r.from === 'wax' && r.to === 'mainnet');
  assert.deepEqual([waxToEth.open, waxToEth.max, waxToEth.reason], [false, '0', 'the Ethereum vault has no USDC to pay out yet']);
  // The other direction still goes.
  assert.equal(all.find((r) => r.from === 'mainnet' && r.to === 'wax').open, true);

  const spent = { ...eth, routes: [usdc({ token: '0xa0b8', available: '900000000', outflowLeft: '0', withdrawableNow: '0' })] };
  const out2 = (routesBetween([spent, wax], telos, { account: HOP, deployed: true }) as any[])
    .find((r) => r.from === 'telos-production' && r.to === 'mainnet');
  assert.equal(out2.reason, "the Ethereum vault's daily USDC limit is used up");
});

test('routes: a full spoke closes the way out, and an empty one the way home', () => {
  const spoke = (over: object) => ({ ...wax, routes: [wax.routes[0] && { ...wax.routes[0], kind: 'spoke', ...over }] });
  const full = routesBetween([eth, spoke({ available: '0', withdrawableNow: '0', depositableNow: '50000000000' })], telos, { account: HOP, deployed: true }) as any[];
  const out = full.find((r) => r.from === 'telos-production' && r.to === 'wax');
  assert.deepEqual([out.open, out.reason], [false, 'the USDC mirror on WAX is at its cap']);
  // A full spoke still takes its mirror home: that is what frees the cap.
  assert.equal(full.find((r) => r.from === 'wax' && r.to === 'telos-production').open, true);

  const none = routesBetween([eth, spoke({ depositableNow: '0' })], telos, { account: HOP, deployed: true }) as any[];
  const home = none.find((r) => r.from === 'wax' && r.to === 'telos-production');
  assert.deepEqual([home.open, home.reason], [false, 'no USDC mirror is out on WAX to bring back']);
  assert.equal(none.find((r) => r.from === 'wax' && r.to === 'mainnet').reason, 'no USDC mirror is out on WAX to bring back');
});

test('routes: Sui and NEAR hop like any chain, the deposit naming the coin, the memo the 32-byte way back', () => {
  const SUI = '3856007665771390095';
  const NEAR = '14338890689662875897';
  const sui = { id: 'sui', name: 'Sui', kind: 'sui', domain: SUI, active: { deposits: true, withdrawals: true },
    routes: [usdc({ coinType: '0xdba3::usdc::USDC', withdrawMemo: `${SUI}:0x<recipient>` })] };
  const near = { id: 'near', name: 'NEAR', kind: 'near', domain: NEAR, active: { deposits: true, withdrawals: true },
    routes: [usdc({ nearToken: '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', withdrawMemo: `${NEAR}:0x<sha256 of the NEAR account id>` })] };
  const all = routesBetween([sui, near, wax], telos, { account: HOP, deployed: true }) as any[];
  const pair = (from: string, to: string) => all.find((r) => r.from === from && r.to === to && r.via);

  assert.deepEqual(pair('sui', 'wax').how, { deposit: { coinType: '0xdba3::usdc::USDC', telosTo: HOP, memo: `${WAX}:<account>|${SUI}:<your address>` } });
  assert.deepEqual(pair('near', 'wax').how, {
    deposit: { nearToken: '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', telosTo: HOP, memo: `${WAX}:<account>|${NEAR}:0x<sha256 of your NEAR account id>` },
  });
  assert.deepEqual(pair('wax', 'near').how, {
    transfer: { contract: 'wrap.alcor', memo: `${HOP}:${NEAR}:0x<sha256 of the NEAR account id>|${WAX}:<your account>` },
  });
  assert.deepEqual(pair('sui', 'near').how.deposit.memo, `${NEAR}:0x<sha256 of the NEAR account id>|${SUI}:<your address>`);
  assert.equal(pair('wax', 'sui').open, true);
  assert.deepEqual(all.find((r) => r.from === 'sui' && r.to === 'telos-production').how, { deposit: { coinType: '0xdba3::usdc::USDC', telosTo: '<telos account>' } });
});
