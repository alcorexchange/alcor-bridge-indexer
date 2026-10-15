/**
 * Small pure pieces: the memo and the bounds a withdrawal has.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { memo } from '../services/indexer/memo.ts';
import { withdrawableNow } from '../services/indexer/chains.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('memo: one computation per ttl, shared by a burst, retried after a failure', async () => {
  let calls = 0;
  const m = memo(40, async () => {
    calls++;
    await sleep(5);
    if (calls === 1) throw new Error('first');
    return calls;
  });
  await assert.rejects(m(), /first/);
  const [a, b] = await Promise.all([m(), m()]);
  assert.equal(a, 2);
  assert.equal(b, 2);
  assert.equal(await m(), 2);
  await sleep(50);
  assert.equal(await m(), 3);
  assert.equal(calls, 3);
});

test('withdrawableNow is the least bound that exists', () => {
  assert.equal(withdrawableNow({ available: '500', maxWithdrawal: '200' }, 900n), '200');
  assert.equal(withdrawableNow({ available: '100', maxWithdrawal: '200' }, 900n), '100');
  assert.equal(withdrawableNow({ available: '500', maxWithdrawal: '200' }, 50n), '50');
  // An uncapped spoke and a vault with no daily limit bound nothing.
  assert.equal(withdrawableNow({ available: null, maxWithdrawal: '200' }, null), '200');
});
