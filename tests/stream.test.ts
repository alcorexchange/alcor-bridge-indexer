/**
 * The bridge's events, kept (events.ts) and served (`/v1/stream`, `/v1/events`):
 * a page opens on a snapshot, is told each change in one word, and after a drop
 * gets exactly what it missed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';

import { createApi, type Deps } from '../services/indexer/api/index.ts';
import { activityContext } from '../services/indexer/api/context.ts';
import type { IndexerConfig } from '../services/indexer/config.ts';
import { Store, depositKey, withdrawalKey } from '../services/indexer/db.ts';
import { EventLog } from '../services/indexer/events.ts';
import { depositEta } from '../src/chains/eta.ts';
import { EVM_CHAINS } from '../src/chains/evm.ts';

const USER = '0x' + 'ab'.repeat(20);
const WAX = '1181148696416462999';

const cfg = {
  instance: 'stream',
  savanna: { id: 'telos-production', name: 'Telos', rpc: ['http://telos.test'], accounts: { bridge: 'bridge.alcor', token: 'tok.alcor', hop: 'hop.alcor' } },
  evm: EVM_CHAINS.mainnet,
  sources: [{ chain: EVM_CHAINS.mainnet, accounts: { lightClient: 'eth.lc.alcor', gateway: 'eth.g.alcor' }, exec: [] }],
  antelope: [],
  sui: [],
  near: [],
  basePath: '',
} as unknown as IndexerConfig;

/** Telos answers with empty tables and every other node is unreachable: only what the store holds is served. */
function offline(): () => void {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === '127.0.0.1') return real(input, init);
    if (url.host === 'telos.test') return new Response(JSON.stringify({ rows: [], more: false, next_key: '' }));
    throw new Error('offline');
  }) as typeof fetch;
  return () => {
    globalThis.fetch = real;
  };
}

function deposit(store: Store, nonce: number, status: 'seen' | 'credited', account = 'bob') {
  store.upsertTransfer({
    key: depositKey(1, nonce), direction: 'deposit', ref: nonce, status, account, evm_address: USER,
    domain: '1', amount: '5000000', src_block: nonce, src_time: 1000 + nonce, src_tx: `0x${nonce}`,
    ...(status === 'credited' ? { dst_time: 2000, dst_tx: `tc${nonce}` } : {}),
  });
}

/** The writes of one pass are recorded together, a moment later. */
const settle = () => new Promise((r) => setTimeout(r, 120));

function depsOf(store: Store): Deps {
  const deps = {
    cfg, store, evms: [], keepers: new Map(), histories: [], startedAt: 0,
    events: new EventLog(store, () => activityContext(deps)),
  } as unknown as Deps;
  deps.events.start();
  return deps;
}

async function serve(store: Store) {
  const deps = depsOf(store);
  const server = createApi(deps);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { deps, server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

type Message = { type: 'snapshot' | 'transfer'; id: number; data: any };

/** A stream, read as its messages arrive. */
async function open(base: string, query: string, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}/v1/stream${query}`, { headers });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  const messages: Message[] = [];
  const pumped = (async () => {
    for (;;) {
      const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
      if (done) return;
      buffered += decoder.decode(value, { stream: true });
      let end: number;
      while ((end = buffered.indexOf('\n\n')) >= 0) {
        const lines = buffered.slice(0, end).split('\n');
        buffered = buffered.slice(end + 2);
        const field = (name: string) => lines.find((l) => l.startsWith(`${name}: `))?.slice(name.length + 2);
        const type = field('event');
        if (type === 'snapshot' || type === 'transfer') messages.push({ type, id: Number(field('id')), data: JSON.parse(field('data')!) });
      }
    }
  })();
  return {
    res,
    messages,
    /** Each message once `n` have arrived, in short: a snapshot's keys, an event's key and change. */
    async after(n: number, ms = 1000) {
      const until = Date.now() + ms;
      while (messages.length < n && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
      return messages.map((m) =>
        m.type === 'snapshot' ? ['snapshot', m.data.transfers.map((t: any) => t.key)] : [m.data.change, m.data.transfer.key, m.data.transfer.state],
      );
    },
    async close() {
      await reader.cancel();
      await pumped;
    },
  };
}

test('what the log holds from before is the baseline: the first change after it is a change, not new', async () => {
  const store = new Store(':memory:');
  deposit(store, 1, 'seen');
  const deps = depsOf(store);
  await settle();
  assert.equal(store.lastEventId(), 0, 'starting makes no events');
  deposit(store, 1, 'credited');
  await settle();
  assert.deepEqual(deps.events.list({ limit: 10 }).map((e) => [e.change, e.transfer.key, e.previous?.state]), [
    ['delivered', 'd:1:1', 'in_progress'],
  ]);
});

test('progress that moves with the clock is an event as well; a later ETA alone is not', async () => {
  const store = new Store(':memory:');
  deposit(store, 1, 'seen');
  const deps = { cfg, store, evms: [], keepers: new Map(), histories: [], startedAt: 0 } as unknown as Deps;
  // No follower and no listed route: finality is estimated, so the clock alone moves it.
  let now = 1001;
  const log = new EventLog(store, () => {
    const c = activityContext(deps);
    return { ...c, progress: { ...c.progress, now } };
  }, 20);
  log.start();
  try {
    const eta = depositEta(EVM_CHAINS.mainnet).seconds;
    now = 1001 + Math.ceil(eta / 2);
    await settle();
    const [moved] = log.list({ limit: 10 });
    assert.equal(log.list({ limit: 10 }).length, 1);
    assert.deepEqual([moved.change, moved.transfer.state, moved.transfer.percent, moved.transfer.exact], ['progress', 'in_progress', 45, false]);
    assert.equal(moved.transfer.etaAt, 1001 + eta);

    now += 1;
    await settle();
    assert.equal(log.list({ limit: 10 }).length, 1, 'the same step a second later is no event');

    deposit(store, 1, 'credited');
    await settle();
    now += eta;
    await settle();
    assert.deepEqual(log.list({ limit: 10 }).map((e) => [e.change, e.transfer.percent, e.transfer.etaAt]), [
      ['progress', 45, 1001 + eta],
      ['delivered', 100, null],
    ]);
  } finally {
    log.stop();
  }
});

test('a stream opens on a snapshot, then each change in a word, and nothing for a rewrite', async () => {
  const restore = offline();
  const store = new Store(':memory:');
  const { server, base } = await serve(store);
  try {
    deposit(store, 1, 'seen');
    await settle();
    const s = await open(base, `?key=${encodeURIComponent(depositKey(1, 1))}`);
    assert.equal(s.res.headers.get('content-type'), 'text/event-stream; charset=utf-8');
    assert.equal(s.res.headers.get('x-accel-buffering'), 'no');
    assert.deepEqual(await s.after(1), [['snapshot', ['d:1:1']]]);
    assert.equal(s.messages[0].id, store.lastEventId());

    deposit(store, 1, 'seen'); // the same row again: a re-read, not a change
    deposit(store, 2, 'seen'); // somebody else's
    await settle();
    deposit(store, 1, 'credited');
    assert.deepEqual(await s.after(2), [['snapshot', ['d:1:1']], ['delivered', 'd:1:1', 'delivered']]);
    assert.deepEqual(s.messages[1].data.previous.state, 'in_progress');
    await settle();
    assert.equal(s.messages.length, 2);
    await s.close();
  } finally {
    server.close();
    restore();
  }
});

test('a key not seen yet is told when it is, and a leg is told as its hop', async () => {
  const restore = offline();
  const store = new Store(':memory:');
  const { server, base } = await serve(store);
  try {
    const s = await open(base, `?key=${encodeURIComponent(depositKey(1, 30))}&key=${encodeURIComponent('v:9')}`);
    assert.deepEqual(await s.after(1), [['snapshot', []]]);
    store.upsertTransfer({
      key: depositKey(1, 30), direction: 'deposit', ref: 30, status: 'forwarded', account: 'hop.alcor', evm_address: USER,
      domain: '1', amount: '5000000', memo: `${WAX}:alice.wam|1:${USER}`, src_block: 1, src_time: 1000,
    });
    await settle();
    store.putHop({
      id: 7, prev: null, deposit: depositKey(1, 30), quantity: '5.000000 USDC', to_domain: WAX,
      to_recipient: 'alice.wam', back_domain: '1', back_recipient: USER, tx: 'tb', block: 2, at: 1060,
    });
    store.upsertTransfer({
      key: withdrawalKey(7), direction: 'withdrawal', ref: 7, status: 'released', account: 'hop.alcor', evm_address: 'alice.wam',
      domain: WAX, amount: '5000000', src_block: 2, src_time: 1060, src_tx: 'tb', dst_time: 1300, dst_tx: 'twax',
    });
    await settle();
    // The rollback asked for as `v:9` is written as withdrawal 9.
    store.upsertTransfer({
      key: withdrawalKey(9), direction: 'withdrawal', ref: 9, status: 'expired', account: 'bob', evm_address: USER,
      domain: '1', amount: '1000000', src_block: 3, src_time: 1100,
    });
    assert.deepEqual(await s.after(4), [
      ['snapshot', []],
      ['new', 'd:1:30', 'in_progress'],
      ['delivered', 'd:1:30', 'delivered'],
      ['new', 'w:9', 'returned'],
    ]);
    await s.close();
  } finally {
    server.close();
    restore();
  }
});

test('parties are matched at either end, any of several, and no filter is the whole feed', async () => {
  const restore = offline();
  const store = new Store(':memory:');
  const { server, base } = await serve(store);
  try {
    deposit(store, 1, 'seen', 'bob');
    await settle();
    // One person, two wallets: a Telos account and an account on another chain.
    const mine = await open(base, '?party=BOB&party=dave');
    const everything = await open(base, '');
    deposit(store, 2, 'seen', 'carol');
    await settle();
    deposit(store, 3, 'seen', 'bob');
    await settle();
    deposit(store, 4, 'seen', 'dave');
    assert.deepEqual(await mine.after(3), [['snapshot', ['d:1:1']], ['new', 'd:1:3', 'in_progress'], ['new', 'd:1:4', 'in_progress']]);
    assert.deepEqual(await everything.after(4), [
      ['snapshot', ['d:1:1']], ['new', 'd:1:2', 'in_progress'], ['new', 'd:1:3', 'in_progress'], ['new', 'd:1:4', 'in_progress'],
    ]);
    const listed = await (await fetch(`${base}/v1/events?party=dave&party=carol`)).json();
    assert.deepEqual(listed.events.map((e: any) => e.transfer.key), ['d:1:2', 'd:1:4']);
    await Promise.all([mine.close(), everything.close()]);
  } finally {
    server.close();
    restore();
  }
});

test('after a drop the stream sends what was missed, or a snapshot when that is gone', async () => {
  const restore = offline();
  const store = new Store(':memory:');
  const { server, base } = await serve(store);
  try {
    const first = await open(base, '?party=bob');
    deposit(store, 1, 'seen');
    assert.deepEqual(await first.after(2), [['snapshot', []], ['new', 'd:1:1', 'in_progress']]);
    const had = first.messages.at(-1)!.id;
    await first.close();

    // Away: one of ours changes, one of somebody else's appears.
    deposit(store, 1, 'credited');
    deposit(store, 2, 'seen', 'carol');
    await settle();

    // What a browser's EventSource sends by itself on reconnecting.
    const back = await open(base, '?party=bob', { 'last-event-id': String(had) });
    assert.deepEqual(await back.after(1), [['delivered', 'd:1:1', 'delivered']]);
    await back.close();

    // Away past what is kept: the events after it are gone, so it starts over.
    store.db.prepare('DELETE FROM events WHERE id <= ?').run(had + 1);
    const late = await open(base, '?party=bob', { 'last-event-id': String(had) });
    assert.deepEqual(await late.after(1), [['snapshot', ['d:1:1']]]);
    await late.close();
  } finally {
    server.close();
    restore();
  }
});

test('/v1/events lists the newest, then after an id, by a leg\'s key too', async () => {
  const restore = offline();
  const store = new Store(':memory:');
  const { server, base } = await serve(store);
  try {
    for (const n of [1, 2, 3]) deposit(store, n, 'seen');
    await settle();
    deposit(store, 1, 'credited');
    await settle();
    const get = async (q: string) => (await fetch(`${base}/v1/events${q}`)).json();

    const newest = await get('?limit=2');
    assert.deepEqual(newest.events.map((e: any) => [e.change, e.transfer.key]), [['new', 'd:1:3'], ['delivered', 'd:1:1']]);
    assert.equal(newest.last, store.lastEventId());

    const after = await get(`?after=${newest.events[0].id}`);
    assert.deepEqual(after.events.map((e: any) => e.transfer.key), ['d:1:1']);
    assert.deepEqual((await get(`?after=${after.last}`)).events, []);

    const one = await get(`?key=${encodeURIComponent(depositKey(1, 1))}`);
    assert.deepEqual(one.events.map((e: any) => e.change), ['new', 'delivered']);

    const bell = await get('?change=delivered&change=returned');
    assert.deepEqual(bell.events.map((e: any) => [e.change, e.transfer.key]), [['delivered', 'd:1:1']]);
    const wrong = await fetch(`${base}/v1/events?change=moved`);
    assert.equal(wrong.status, 400);
    assert.equal((await wrong.json()).code, 'INVALID_REQUEST');
  } finally {
    server.close();
    restore();
  }
});

test('streams are bounded per address, and keys per stream', async () => {
  const restore = offline();
  const store = new Store(':memory:');
  const { server, base } = await serve(store);
  try {
    const held = await Promise.all(Array.from({ length: 10 }, () => open(base, '', { 'x-real-ip': '203.0.113.7' })));
    const refused = await fetch(`${base}/v1/stream`, { headers: { 'x-real-ip': '203.0.113.7' } });
    assert.equal(refused.status, 429);
    assert.equal((await refused.json()).code, 'RATE_LIMITED');
    const other = await open(base, '', { 'x-real-ip': '203.0.113.8' });
    assert.equal(other.res.status, 200);

    const many = Array.from({ length: 51 }, (_, i) => `key=d:1:${i}`).join('&');
    const tooMany = await fetch(`${base}/v1/stream?${many}`);
    assert.deepEqual([tooMany.status, (await tooMany.json()).code], [400, 'INVALID_REQUEST']);
    await Promise.all([...held, other].map((s) => s.close()));
  } finally {
    server.close();
    restore();
  }
});
