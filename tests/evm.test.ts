/**
 * The EVM follower's freeze loop, against a prover that answers from memory:
 * what is mature is frozen and stored once, what is not waits, a failure stays
 * queued, and the deposit's row moves to `provable`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EvmFollower, TOPICS } from '../services/indexer/evm.ts';
import { Store, depositKey, voidKey } from '../services/indexer/db.ts';
import type { Frozen, LogToFreeze, Prover } from '../services/indexer/prover.ts';
import type { IndexerConfig } from '../services/indexer/config.ts';
import type { EvmChain } from '../src/chains/evm.ts';

const CHAIN = {
  id: 'test-evm',
  chainId: 999,
  strategy: 'parlia',
  exec: ['http://127.0.0.1:9'],
  vault: '0x00000000000000000000000000000000000000aa',
} as unknown as EvmChain;

class FakeProver implements Prover {
  frozen: string[] = [];
  failing = new Set<string>();
  mature: number;
  constructor(mature: number) {
    this.mature = mature;
  }
  async matureBelow(): Promise<number> {
    return this.mature;
  }
  async freeze(p: LogToFreeze): Promise<Frozen> {
    if (this.failing.has(p.key)) throw new Error(`no receipt for ${p.tx}`);
    this.frozen.push(p.key);
    return {
      body: JSON.stringify({ kind: p.kind, key: p.key }),
      blockNumber: 0,
      signedBy: '3/4',
      committee: { period: 7, keys: 'k', aggKey: 'a' },
    };
  }
}

test('one freeze loop: mature logs are frozen and recorded, the rest wait', async () => {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'alcor-evm-')), 'indexer.sqlite'));
  const cfg = { evm: { id: 'not-this-one' } } as unknown as IndexerConfig;
  const follower = new EvmFollower(cfg, store, { chain: CHAIN, accounts: { lightClient: 'lc', gateway: 'gw' } });
  const prover = new FakeProver(100);
  // The follower's insides, driven directly: no
  // node is asked anything, so the times of the blocks are put in by hand.
  const inner = follower as any;
  inner.prover = prover;
  inner.state.head = 200;
  for (const block of [90, 95, 150]) inner.blockTimes.set(block, block * 10);

  const queue = (key: string, kind: 'deposit' | 'void', ref: number, block: number) =>
    inner.awaitingFinality.set(key, { key, kind, ref, block, tx: `0x${ref}`, address: CHAIN.vault, topic0: TOPICS.deposit });
  store.upsertTransfer({ key: depositKey(999, 1), direction: 'deposit', ref: 1, status: 'seen', domain: '999', src_block: 90, src_time: 900, src_tx: '0x1' });
  queue(depositKey(999, 1), 'deposit', 1, 90);
  queue(voidKey(5), 'void', 5, 95);
  queue(depositKey(999, 2), 'deposit', 2, 95); // a deposit row recovered from nothing
  queue(depositKey(999, 3), 'deposit', 3, 150); // not mature yet
  queue(depositKey(999, 4), 'deposit', 4, 90);
  prover.failing.add(depositKey(999, 4));

  await inner.freezeMatured();

  assert.deepEqual(prover.frozen, [depositKey(999, 1), voidKey(5), depositKey(999, 2)]);
  assert.equal(follower.state.frozen, 3);
  assert.equal(follower.state.provableUpTo, 100);
  assert.deepEqual([...inner.awaitingFinality.keys()], [depositKey(999, 3), depositKey(999, 4)]);
  assert.ok(store.getCommittee(7));
  assert.equal(JSON.parse(store.getProof(voidKey(5))!.body).kind, 'void');

  const first = store.getTransfer(depositKey(999, 1))!;
  assert.deepEqual([first.status, first.src_block, first.src_time], ['provable', 90, 900]);
  assert.ok(first.proof_at);
  const second = store.getTransfer(depositKey(999, 2))!;
  assert.deepEqual([second.status, second.src_block, second.src_time], ['provable', 95, 950]);
  assert.equal(store.recentIncidents(1)[0].kind, 'log-freeze');

  // A proof already stored is never frozen twice.
  prover.failing.clear();
  store.putProof(depositKey(999, 4), 'deposit', '{}');
  await inner.freezeMatured();
  assert.equal(prover.frozen.length, 3);
  assert.deepEqual([...inner.awaitingFinality.keys()], [depositKey(999, 3)]);
  store.close();
});
