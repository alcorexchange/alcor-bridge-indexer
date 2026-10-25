/**
 * The EVM follower's freeze loop, against a prover that answers from memory:
 * what is mature is frozen and stored once, what is not waits, a failure stays
 * queued, and the deposit's row moves to `provable`. And the settled-withdrawal
 * check: what it searches, and when it files an incident.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EvmFollower } from '../services/indexer/evm.ts';
import { TOPICS } from '../src/chains/evm.ts';
import { Store, depositKey, voidKey, withdrawalKey } from '../services/indexer/db.ts';
import type { Frozen, LogToFreeze, Prover } from '../src/proof/prover.ts';
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
  const follower = new EvmFollower(cfg, store, { chain: CHAIN, accounts: { lightClient: 'lc', gateway: 'gw' }, exec: [] });
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

test('a withdrawal settled on the vault: searched in exact spans, an incident only when nobody saw it', async () => {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'alcor-evm-')), 'indexer.sqlite'));
  const cfg = { evm: { id: 'not-this-one' } } as unknown as IndexerConfig;
  const follower = new EvmFollower(cfg, store, { chain: CHAIN, accounts: { lightClient: 'lc', gateway: 'gw' }, exec: [] });
  const inner = follower as any;
  // The node is a block behind the poller, and no endpoint has the event.
  inner.state.head = 600_001;
  const ranges: Array<[number, number]> = [];
  let onSearch = () => {};
  inner.exec = {
    urls: [],
    rpc: async () => '0x' + '1'.padStart(64, '0'),
    head: async () => 600_000,
    logs: async (f: any) => {
      ranges.push([Number(f.fromBlock), Number(f.toBlock)]);
      onSearch();
      return [];
    },
  };
  const open = (ref: number) =>
    store.upsertTransfer({ key: withdrawalKey(ref), direction: 'withdrawal', ref, status: 'provable', domain: '999', src_block: 1, src_time: 1 });
  const settledElsewhere = () => store.recentIncidents(10).filter((i) => i.kind === 'settled-elsewhere');

  // The poller records the release while the search is still walking history.
  open(1);
  onSearch = () => store.upsertTransfer({ key: withdrawalKey(1), direction: 'withdrawal', ref: 1, status: 'released', dst_block: 599_999 });
  assert.equal(await follower.checkSettled(), 1);
  assert.equal(settledElsewhere().length, 0);
  assert.deepEqual([store.getTransfer(withdrawalKey(1))!.status, store.getTransfer(withdrawalKey(1))!.dst_block], ['released', 599_999]);

  // From the poller's head down, two topics per span, every span exactly
  // LOG_SPAN blocks or the remainder, no block twice, none skipped.
  const spans = ranges.filter((_, i) => i % 2 === 0);
  assert.deepEqual(spans[0], [598_002, 600_001]);
  for (const [from, to] of spans) assert.ok(to - from + 1 <= 2_000);
  for (let i = 1; i < spans.length; i++) assert.equal(spans[i][1], spans[i - 1][0] - 1);
  assert.equal(spans.at(-1)![0], 100_001);

  // Nobody saw this one: that is the incident.
  open(2);
  onSearch = () => {};
  assert.equal(await follower.checkSettled(), 1);
  assert.equal(settledElsewhere().length, 1);
  assert.match(settledElsewhere()[0].detail, /withdrawal 2 .* event not found/);
  assert.equal(store.getTransfer(withdrawalKey(2))!.status, 'released');
  store.close();
});
