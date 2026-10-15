/**
 * memo: one computation at a time, kept for a time that may depend on the value.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { memo } from '../services/indexer/memo.ts';

test('a value is kept for as long as its own ttl says', async () => {
  let calls = 0;
  const read = memo((v: { partial: boolean }) => (v.partial ? 0 : 60_000), async () => {
    calls += 1;
    return { partial: calls === 1 };
  });
  assert.deepEqual(await read(), { partial: true });
  // The partial value was not kept: the next call reads again, and keeps that.
  assert.deepEqual(await read(), { partial: false });
  assert.deepEqual(await read(), { partial: false });
  assert.equal(calls, 2);
});

test('callers arriving together share one computation', async () => {
  let calls = 0;
  const read = memo(60_000, async () => ++calls);
  assert.deepEqual(await Promise.all([read(), read(), read()]), [1, 1, 1]);
});
