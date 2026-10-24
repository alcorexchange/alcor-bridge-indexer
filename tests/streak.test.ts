/**
 * A loop's failures: one 504 is only logged; failures that keep coming for five
 * minutes are one incident, and a pause starts the count over.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FailureStreak } from '../services/indexer/streak.ts';

const MIN = 60_000;

test('a single failure, or a few apart, is no incident', () => {
  const said: string[] = [];
  const streak = new FailureStreak((d) => said.push(d));
  streak.failed('HTTP 504', 0);
  streak.failed('HTTP 504', 3 * MIN);
  streak.failed('HTTP 504', 6 * MIN);
  assert.deepEqual(said, []);
});

test('failures that keep coming for five minutes are said once, with the latest error', () => {
  const said: string[] = [];
  const streak = new FailureStreak((d) => said.push(d));
  for (let t = 0; t <= 8 * MIN; t += 10_000) streak.failed(t < 4 * MIN ? 'HTTP 504' : 'timeout', t);
  assert.deepEqual(said, ['failing for 5 min: timeout']);

  // Recovered, then down again: a new streak.
  for (let t = 20 * MIN; t <= 26 * MIN; t += 10_000) streak.failed('HTTP 502', t);
  assert.deepEqual(said, ['failing for 5 min: timeout', 'failing for 5 min: HTTP 502']);
});
