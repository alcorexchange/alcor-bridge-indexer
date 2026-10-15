/**
 * Progress: counted from confirmations where a fast route gives them, estimated
 * from the measured timings where it does not, and never an ETA for a step that
 * waits on the user.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { TransferRow } from '../services/indexer/db.ts';
import { transferProgress, type ProgressContext } from '../services/indexer/progress.ts';
import { antelopeDepositEta, antelopeWithdrawalEta } from '../src/chains/eta.ts';
import { antelopeById } from '../src/chains/antelope.ts';

const waxChain = antelopeById('wax')!;

const WAX = '1181148696416462999';
const NOW = 10_000;
const finality = { seconds: 900, range: [780, 1140] as [number, number], parts: [], measured: true, human: '15 min' };

const ctx: ProgressContext = {
  now: NOW,
  evmHead: (d) => (d === '1' ? 1005 : undefined),
  route: () => ({ id: 2, optimisticMax: 5_000_000_000n, minConfirmations: 12, depositsOpen: true }),
  chainName: (d) => (d === '1' ? 'Ethereum' : d === WAX ? 'WAX' : 'the far chain'),
  isAntelope: (d) => d === WAX,
  depositEta: (d) => (d === WAX ? antelopeDepositEta(waxChain) : finality),
  withdrawalEta: (d) => (d === WAX ? antelopeWithdrawalEta(waxChain) : null),
};

const row = (over: Partial<TransferRow>): TransferRow => ({
  key: 'k', direction: 'deposit', ref: 1, status: 'seen', account: 'alice', evm_address: null, token: 'aa',
  symbol: null, amount: '5000000', amount_raw: null, domain: '1', src_block: 1000, src_time: NOW - 60,
  src_tx: null, dst_block: null, dst_time: null, dst_tx: null, deadline: null, proof_at: null,
  refund_tx: null, memo: null, updated_at: NOW, ...over,
});

test('an Ethereum deposit on the fast path is counted in confirmations, as the ledger counts them', () => {
  // Blocks on top of the deposit's own: head 1005 over block 1000 is 5. The
  // light client's proved depth is the ancestry from the deposit's block up to,
  // not including, the signed head (`ethlightclnt`, `descend_to_carrier`:
  // `return ancestry.size()`), and the ledger credits at
  // `depth >= route->min_confirmations` (the ledger's `credit`).
  assert.deepEqual(transferProgress(row({}), ctx), {
    stage: '5 of 12 confirmations on Ethereum', percent: 38, etaSeconds: 7 * 12 + 5, exact: true, waitingOn: 'bridge',
  });
  const twelve = transferProgress(row({ src_block: 993 }), ctx);
  assert.deepEqual([twelve.stage, twelve.percent], ['confirmed; proving it on Telos', 95]);
  const eleven = transferProgress(row({ src_block: 994 }), ctx);
  assert.equal(eleven.stage, '11 of 12 confirmations on Ethereum');
  const confirmed = transferProgress(row({ src_block: 990 }), ctx);
  assert.deepEqual([confirmed.stage, confirmed.percent], ['confirmed; proving it on Telos', 95]);
});

test('a deposit over the fast ceiling waits for finality, estimated', () => {
  const p = transferProgress(row({ amount: '6000000000', src_time: NOW - 450 }), ctx);
  assert.deepEqual(p, { stage: 'waiting for Ethereum to finalize', percent: 48, etaSeconds: 450, exact: false, waitingOn: 'bridge' });
});

test('a WAX deposit is estimated from the measured producer rounds, and never claims to be done', () => {
  const p = transferProgress(row({ domain: WAX, src_time: NOW - 20 }), ctx);
  assert.equal(p.stage, 'WAX producers confirming');
  assert.equal(p.exact, false);
  assert.equal(p.etaSeconds, antelopeDepositEta(waxChain).seconds - 20);
  const late = transferProgress(row({ domain: WAX, src_time: NOW - 600 }), ctx);
  assert.deepEqual([late.percent, late.etaSeconds], [95, 5]);
});

test('a withdrawal to Ethereum waits on the user once provable, with no ETA', () => {
  const p = transferProgress(row({ direction: 'withdrawal', status: 'provable' }), ctx);
  assert.deepEqual(p, { stage: 'ready: release it on Ethereum', percent: 50, etaSeconds: null, exact: true, waitingOn: 'user' });
});

test('finished crossings are 100 with nothing waiting', () => {
  for (const [direction, status, stage] of [
    ['deposit', 'credited', 'credited on Telos'],
    ['deposit', 'forwarded', 'delivered on Telos'],
    ['withdrawal', 'released', 'paid out on Ethereum'],
    ['withdrawal', 'refunded', 'expired unpaid; refunded on Telos'],
  ] as const) {
    assert.deepEqual(transferProgress(row({ direction, status }), ctx), { stage, percent: 100, etaSeconds: null, exact: true, waitingOn: null });
  }
});
