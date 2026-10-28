/**
 * Holds: a parked deposit that stays parked, a deposit over its route's cap,
 * a withdrawal over what the vault still lets out today — and the progress
 * they replace.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { TransferRow } from '../services/indexer/db.ts';
import { HELD_AFTER_SECONDS, holdOf, isLarge, type HoldContext, type RouteRoom } from '../services/indexer/holds.ts';
import { transferProgress, type ProgressContext } from '../services/indexer/progress.ts';

const XPR = '4057084141687023600';
const NOW = 100_000;

const backing: RouteRoom = { cap: 220_000_000_000n, backing: 365_000_000n, maxWithdrawal: 220_000_000_000n, spoke: false };
const spoke: RouteRoom = { cap: 50_000_000_000n, backing: 0n, maxWithdrawal: 50_000_000_000n, spoke: true };
const bscUsdc: RouteRoom = { cap: 30_000_000_000n, backing: 4_000_000_000n, maxWithdrawal: 10_000_000_000n, spoke: false };

const ctx = (over: Partial<HoldContext> = {}): HoldContext => ({
  now: NOW,
  route: (token) => (token === 'xpr' ? backing : token === 'usdc-xpr' ? spoke : token === 'usdc-bsc' ? bscUsdc : undefined),
  outflow: (token) => (token === 'usdc-bsc' ? { left: 9_000_000_000n, perDay: 10_000_000_000n } : token === 'bnb' ? null : undefined),
  chainName: (d) => (d === '56' ? 'BNB Chain' : d === XPR ? 'XPR' : 'the far chain'),
  ...over,
});

const row = (over: Partial<TransferRow>): TransferRow => ({
  key: 'k', direction: 'deposit', ref: 7, status: 'seen', account: 'alice', evm_address: null, token: 'xpr',
  symbol: null, amount: '1000000', amount_raw: null, domain: XPR, src_block: 1, src_time: NOW - 60,
  src_tx: null, dst_block: null, dst_time: null, dst_tx: null, deadline: null, proof_at: null,
  refund_tx: null, memo: null, fee: null, updated_at: NOW, ...over,
});

test('a parked deposit is held once it has waited past the grace period, not before', () => {
  assert.equal(holdOf(row({ status: 'parked', dst_time: NOW - 60 }), ctx()), null);
  const held = holdOf(row({ status: 'parked', dst_time: NOW - HELD_AFTER_SECONDS }), ctx());
  assert.deepEqual(held, { flag: 'held', stage: 'Held for review on Telos — the funds are safe', until: null });
});

test('a deposit over its backing route\'s cap is over the limit; a spoke and an uncapped route never are', () => {
  // 22M XPR cap, 36.5k backed: 85M does not fit, 1M does.
  assert.equal(holdOf(row({ amount: '850000000000' }), ctx())?.flag, 'over-limit');
  assert.equal(holdOf(row({ amount: '10000000000' }), ctx()), null);
  assert.equal(holdOf(row({ token: 'usdc-xpr', amount: '900000000000' }), ctx()), null);
  assert.equal(holdOf(row({ token: 'eth', amount: '900000000000' }), ctx()), null);
  // Once credited, the cap was met: nothing holds a booked deposit but parking.
  assert.equal(holdOf(row({ status: 'credited', amount: '850000000000' }), ctx()), null);
});

test('a withdrawal over what the vault still lets out today waits, with when it fits', () => {
  const w = (amount: string, status: TransferRow['status'] = 'provable') =>
    row({ direction: 'withdrawal', status, token: 'usdc-bsc', domain: '56', amount });
  assert.equal(holdOf(w('9000000000'), ctx()), null);
  // 1,000 over a 10,000-a-day limit: a tenth of a day.
  assert.deepEqual(holdOf(w('10000000000'), ctx()), {
    flag: 'daily-limit', stage: "Over today's limit for BNB Chain — it goes out when the limit resets", until: NOW + 8640,
  });
  assert.equal(holdOf(w('10000000000', 'released'), ctx()), null);
  assert.equal(holdOf(w('10000000000', 'expired'), ctx()), null);
  // Unmetered, or not read yet: nothing to say.
  assert.equal(holdOf(row({ direction: 'withdrawal', status: 'provable', token: 'bnb', domain: '56' }), ctx()), null);
  assert.equal(holdOf(row({ direction: 'withdrawal', status: 'provable', token: 'eth', domain: '1' }), ctx()), null);
});

test('a hold replaces the estimate in progress, keeping how far it got', () => {
  const progressCtx = (hold: HoldContext): ProgressContext => ({
    now: NOW,
    evmHead: () => undefined,
    route: () => undefined,
    chainName: hold.chainName,
    isAntelope: (d) => d === XPR,
    depositEta: () => null,
    withdrawalEta: () => null,
    hold: (r) => holdOf(r, hold),
  });
  const parked = transferProgress(row({ status: 'parked', dst_time: NOW - 3600 }), progressCtx(ctx()));
  assert.deepEqual(parked, {
    stage: 'Held for review on Telos — the funds are safe', percent: 97, etaSeconds: null, exact: false, waitingOn: 'bridge',
  });
  const waiting = transferProgress(
    row({ direction: 'withdrawal', status: 'provable', token: 'usdc-bsc', domain: '56', amount: '10000000000' }),
    progressCtx(ctx()),
  );
  assert.deepEqual([waiting.etaSeconds, waiting.waitingOn], [8640, 'bridge']);
});

test('a withdrawal is large from half its route\'s maximum', () => {
  const w = (amount: string) => row({ direction: 'withdrawal', status: 'released', amount });
  assert.equal(isLarge(w('5000000000'), bscUsdc), true);
  assert.equal(isLarge(w('4999999999'), bscUsdc), false);
  assert.equal(isLarge(row({ amount: '9000000000' }), bscUsdc), false);
  assert.equal(isLarge(w('9000000000'), undefined), false);
});
