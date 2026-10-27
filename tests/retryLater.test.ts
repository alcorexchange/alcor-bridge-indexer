/**
 * A failed job waits before its next try, twice as long after each failure in a
 * row, up to a cap; a success starts it over.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { RetryLater } from '../services/indexer/retryLater.ts';

test('each failure doubles the wait, up to the cap', () => {
  const retry = new RetryLater({ firstMs: 1_000, maxMs: 5_000 });
  assert.equal(retry.failed('k', 0), 1_000);
  assert.equal(retry.failed('k', 1_000), 2_000);
  assert.equal(retry.failed('k', 3_000), 4_000);
  assert.equal(retry.failed('k', 7_000), 5_000);
});

test('a key is due only once its wait is over, and other keys are unaffected', () => {
  const retry = new RetryLater({ firstMs: 1_000, maxMs: 60_000 });
  assert.equal(retry.due('k', 0), true);
  retry.failed('k', 0);
  assert.equal(retry.due('k', 999), false);
  assert.equal(retry.due('k', 1_000), true);
  assert.equal(retry.due('other', 1), true);
});

test('a success forgets the failures', () => {
  const retry = new RetryLater({ firstMs: 1_000, maxMs: 60_000 });
  retry.failed('k', 0);
  retry.failed('k', 1_000);
  retry.succeeded('k');
  assert.equal(retry.due('k', 1_001), true);
  assert.equal(retry.failed('k', 1_001), 1_000);
});
