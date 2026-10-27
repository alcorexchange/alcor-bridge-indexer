/**
 * The HTTP surface, pinned: every stored proof shape, the queue, one transfer,
 * the chains and the routes, answered against a temporary store, fake
 * followers and stubbed nodes, and compared with `api.golden.json`.
 *
 * The golden file is the public contract. A change to it is a change to what a
 * front end reads, so it is regenerated on purpose only:
 *
 *   UPDATE_GOLDEN=1 node --test tests/indexer/api.test.ts
 *
 * and the diff of that file is the review.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';

import { createApi, type Deps } from '../services/indexer/api/index.ts';
import { antelopeChains, type IndexerConfig } from '../services/indexer/config.ts';
import { Store, depositKey, voidKey, withdrawalKey } from '../services/indexer/db.ts';
import { symbolCodeRaw } from '../services/indexer/fast.ts';
import { EVM_CHAINS } from '../src/chains/evm.ts';
import { MULTICALL3, word } from '../src/evm/multicall.ts';
import { nameToUint64 } from '../src/proof/pack.ts';

const GOLDEN = join(dirname(fileURLToPath(import.meta.url)), 'api.golden.json');
const NOW = 1_800_000_000;
const WAX = '1181148696416462999';
const NATIVE = '0'.repeat(40);

// --- the chains this instance follows -------------------------------------------

const mainnet = { ...EVM_CHAINS.mainnet, exec: ['http://eth.test'] };
const bsc = { ...EVM_CHAINS.bsc, exec: ['http://bsc.test'] };
const polygon = { ...EVM_CHAINS.polygon, exec: ['http://pol.test'] };

const sources = [
  { chain: mainnet, accounts: { lightClient: 'eth.lc.alcor', gateway: 'eth.g.alcor' }, exec: mainnet.exec },
  { chain: bsc, accounts: { lightClient: 'bsc.lc.alcor', gateway: 'bsc.g.alcor' }, exec: bsc.exec },
  { chain: polygon, accounts: { lightClient: 'pol.lc.alcor', gateway: 'pol.g.alcor' }, exec: polygon.exec },
];

const cfg = {
  instance: 'golden',
  savanna: {
    id: 'telos-production',
    name: 'Telos',
    rpc: ['http://telos.test'],
    blockIntervalMs: 500,
    accounts: { bridge: 'bridge.alcor', token: 'tok.alcor', hop: 'hop.alcor', lightClient: 'tls.lc.alcor' },
  },
  evm: mainnet,
  sources,
  proofPayer: 'pay.alcor',
  accounts: { bridge: 'bridge.alcor', token: 'tok.alcor', lightClient: 'eth.lc.alcor', gateway: 'eth.g.alcor' },
  history: [],
  beaconUrls: ['http://beacon.test'],
  checkpointDir: mkdtempSync(join(tmpdir(), 'alcor-api-cp-')),
  basePath: '',
  maxAncestry: 4096,
  antelope: antelopeChains({ WAX_SHIP_URL: 'ws://unused', WAX_RPC: 'http://wax.test' }, 'data'),
} as unknown as IndexerConfig;

// --- what the nodes answer ------------------------------------------------------

/** A name as the ledger packs it: eight bytes, little-endian. */
function packed(name: string): string {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(nameToUint64(name));
  return b.toString('hex');
}

const evmRoute = (id: number, domain: string, vault: string, gateway: string, sym: string, optimisticMax: string) => ({
  id, domain, vault: vault.replace(/^0x/, ''), gateway, asset_id: symbolCodeRaw(sym), ext_token: NATIVE,
  min_deposit: '10000', cap: '0', scale: '10000000000', backing: '90000000', max_withdrawal: '50000000',
  optimistic_max: optimisticMax, min_confirmations: 12, deposits_open: 1, withdrawals_open: 1,
});

const waxRoute = {
  id: 10, domain: WAX, vault: packed('bridge.alcor'), gateway: 'wax.g.alcor', asset_id: symbolCodeRaw('8,WAX'),
  ext_token: packed('eosio.token') + Buffer.from([8, ...Buffer.from('WAX'.padEnd(7, '\0'))]).toString('hex'),
  min_deposit: '100000', cap: '0', scale: '1', backing: '5000000', max_withdrawal: '10000000',
  optimistic_max: '0', min_confirmations: 0, deposits_open: 1, withdrawals_open: 1,
};

const TELOS: Record<string, unknown[]> = {
  'bridge.alcor/routes': [
    evmRoute(1, '1', mainnet.vault!, 'eth.g.alcor', '8,ETH', '1000000'),
    evmRoute(2, '56', bsc.vault!, 'bsc.g.alcor', '8,BNB', '0'),
    evmRoute(3, '137', polygon.vault!, 'pol.g.alcor', '8,POL', '0'),
    waxRoute,
  ],
  'bridge.alcor/assets': [{ sym: '8,ETH' }, { sym: '8,BNB' }, { sym: '8,POL' }, { sym: '8,WAX' }],
  'bridge.alcor/spokes': [],
  'wax.g.alcor/config': [{ light_client: 'wax.lc.alcor' }],
  'wax.lc.alcor/core': [{ version: 7, keys: ['k'] }],
  'wax.lc.alcor/blocks': [{ block_num: 400000000, id: 'ef', signers: 6 }],
  'eth.lc.alcor/headers': [{ block_number: 990, block_hash: 'aa', at: '2027-01-15T08:00:00', signers: 400 }],
};
const WAXNODE: Record<string, unknown[]> = {
  'bridge.alcor/config': [{ light_client: 'tls.lc.alcor', paused: 0 }],
  'tls.lc.alcor/policy': [{ version: 5, producers: [{ producer_name: 'p' }] }],
};
const ANTELOPE_CALLS: Record<string, Record<string, unknown>> = {
  'telos.test': {
    '/v1/chain/get_finalizer_info': { active_finalizer_policy: { generation: 185 }, pending_finalizer_policy: null },
    '/v1/chain/get_producer_schedule': { active: { version: 5 }, pending: null, proposed: null },
    '/v1/chain/get_code_hash': { code_hash: 'ab'.repeat(32) },
  },
  'wax.test': {
    '/v1/chain/get_info': { head_block_num: 400000050 },
    '/v1/chain/get_producer_schedule': { active: { version: 7 } },
  },
};
const EVM_HEADS: Record<string, number> = { 'eth.test': 1005, 'bsc.test': 50_000_000, 'pol.test': 70_000_000 };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Multicall3's answer to an `aggregate3` request: every call succeeds with four zero words, as a plain `eth_call` does here. */
function multicallOfZeros(data: string): string {
  const count = Number(BigInt('0x' + data.slice(10 + 64, 10 + 128)));
  const element = word(1n) + word(0x40n) + word(128n) + '0'.repeat(256);
  const offsets = Array.from({ length: count }, (_, i) => word(BigInt(32 * count + i * (element.length / 2)))).join('');
  return '0x' + word(0x20n) + word(BigInt(count)) + offsets + element.repeat(count);
}

/** Telos and WAX by host, any JSON-RPC as an EVM node, and the API itself on 127.0.0.1. */
function stubNodes(): () => void {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL, init?: { body?: string }) => {
    const url = new URL(String(input));
    if (url.hostname === '127.0.0.1') return real(input, init as RequestInit);
    const body = init?.body ? JSON.parse(init.body) : undefined;
    if (url.host === 'telos.test' || url.host === 'wax.test') {
      if (url.pathname === '/v1/chain/get_table_rows') {
        const rows = (url.host === 'telos.test' ? TELOS : WAXNODE)[`${body.code}/${body.table}`] ?? [];
        return json({ rows: body.reverse ? [...rows].reverse().slice(0, body.limit) : rows, more: false, next_key: '' });
      }
      const answer = ANTELOPE_CALLS[url.host][url.pathname];
      return answer === undefined ? json({}, 400) : json(answer);
    }
    if (body?.jsonrpc) {
      const result =
        body.method === 'eth_blockNumber' ? '0x' + (EVM_HEADS[url.host] ?? 1005).toString(16)
          : body.method === 'eth_call' && String(body.params[0].to).toLowerCase() === MULTICALL3.toLowerCase()
            ? multicallOfZeros(body.params[0].data)
          : body.method === 'eth_call' ? '0x' + '0'.repeat(256)
            : body.method === 'eth_getBalance' ? '0x0'
              : null;
      return json({ jsonrpc: '2.0', id: body.id, result });
    }
    throw new Error(`no stub for ${url.host}`);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = real;
  };
}

// --- what the store holds -------------------------------------------------------

function seed(store: Store): void {
  const row = (r: Record<string, unknown>) => store.upsertTransfer({
    status: 'seen', account: 'alice', evm_address: '0xabc', token: '0x' + NATIVE, src_tx: '0xt',
    src_block: 1000, src_time: NOW - 60, ...r,
  } as any);
  const deposit = (domain: string, nonce: number, r: Record<string, unknown>) =>
    row({ key: depositKey(domain, nonce), direction: 'deposit', ref: nonce, domain, ...r });
  const withdrawal = (id: number, domain: string, r: Record<string, unknown>) =>
    row({ key: withdrawalKey(id), direction: 'withdrawal', ref: id, domain, status: 'burned', src_tx: '0xburn', ...r });

  // Counting confirmations: 5 of the route's 12 at a follower head of 1005.
  deposit('1', 1, { amount: '500000' });
  // Over the fast ceiling and old: only the finalized proof, and its ancestry runs out.
  deposit('1', 2, { amount: '5000000', src_block: 990, src_time: NOW - 20 * 3600 });
  // Stored proofs of every shape.
  deposit('1', 3, { amount: '5000000', status: 'provable', proof_at: NOW - 100 });
  deposit('137', 4, { amount: '7000000', status: 'provable', proof_at: NOW - 100 });
  deposit('56', 5, { amount: '7000000', status: 'provable', proof_at: NOW - 100 });
  deposit('137', 6, { amount: '7000000', status: 'provable', proof_at: NOW - 100 });
  withdrawal(7, '56', { status: 'expired', amount: '3000000', deadline: NOW - 10 });
  withdrawal(8, '1', { amount: '3000000', deadline: NOW + 86_400, src_block: 1200 });
  // Burned with a delivery fee: the courier releases it.
  withdrawal(9, '1', { status: 'provable', amount: '3000000', fee: '21000', deadline: NOW + 86_400, src_block: 1200 });
  withdrawal(10, '999', { amount: '3000000', src_block: 1200 });
  // An Antelope deposit and withdrawal, proved and released by their relayers.
  deposit(WAX, 12, { amount: '2000000000', token: waxRoute.ext_token, evm_address: 'bob' });
  withdrawal(13, WAX, { amount: '2000000000', token: waxRoute.ext_token, evm_address: 'bob' });
  deposit('1', 14, { amount: '500000', status: 'credited', dst_tx: 'cafe', dst_time: NOW - 30 });
  // A BSC deposit waiting half a day: seconds of finality, so no ancestry clock.
  deposit('56', 15, { amount: '7000000', src_block: 49_999_990, src_time: NOW - 12 * 3600 });
  withdrawal(16, '1', { amount: '3000000', deadline: NOW + 86_400, src_block: 2500 });
  // The courier's for an hour and still not released: late, and anyone's to send.
  withdrawal(17, '1', { status: 'provable', amount: '3000000', fee: '21000', proof_at: NOW - 3600,
    deadline: NOW + 86_400, src_block: 1200 });

  const proveroot = {
    payer: 'eth.lc.alcor', signed_header: { slot: 1 }, sig: 's', bits: 'b', finalized: [], finality_branch: [],
    ancestry: [], receipts_root: 'r', receipts_branch: [], block_number: 1000, number_branch: [], block_hash: 'h',
    hash_branch: [], exec_branch: [], state_root: 'sr', state_branch: [],
  };
  store.putCommittee(100, 'kk', 'ag');
  store.putProof(depositKey('1', 3), 'deposit', JSON.stringify({
    kind: 'deposit', committeePeriod: 100, blockNumber: 1000, blockHash: 'h', signedBy: '400/512', ancestry: 64,
    proveroot, gateway: { payer: 'eth.g.alcor', block_hash: 'h', key: '80', nodes: ['n'], log_index: 1 },
  }));
  store.putProof(depositKey('137', 4), 'deposit', JSON.stringify({
    kind: 'deposit', committeePeriod: 100, blockNumber: 900, signedBy: '400/512', ancestry: 3, fallback: 'checkpoint',
    proveroot, gateway: ['pol.g.alcor', '137', 'cp', 'bor', 'h', '80', ['n'], 1],
  }));
  const parlia = (blockNumber: number) => JSON.stringify({
    strategy: 'parlia', blockNumber, blockHash: '0xh', signedBy: '15/21', epoch: 49_999_000, finalizedBy: blockNumber + 2,
    proveroot: ['bsc.lc.alcor', 'header', 'vote'], gateway: ['bsc.lc.alcor', 'h', '80', ['n'], 0],
  });
  store.putProof(depositKey('56', 5), 'deposit', parlia(49_999_900));
  store.putProof(depositKey('137', 6), 'deposit', JSON.stringify({
    kind: 'deposit', strategy: 'milestone', blockNumber: 69_999_000, blockHash: '0xh', gateway: ['pol.lc.alcor', 'h', '80', ['n'], 0],
  }));
  store.putProof(voidKey(7), 'void', parlia(49_999_950));

  const artifact = (domain: string, burnBlock = 1200) => JSON.stringify({
    burnBlock, rootBlock: burnBlock + 10, vault: mainnet.vault,
    submitRoot: { finality: { activeGeneration: 1, lastPendingGeneration: 1, finalityMroot: 'ff' }, pending: { policy: '0x', bits: '0x', signature: '0x' } },
    release: { domain, id: 9, blockNum: 1200 },
  });
  for (const id of [8, 9]) store.putProof(withdrawalKey(id), 'withdrawal', artifact('1'));
  store.putProof(withdrawalKey(16), 'withdrawal', artifact('1', 2500));
  store.putProof(withdrawalKey(17), 'withdrawal', artifact('1'));
  store.putProof(withdrawalKey(10), 'withdrawal', artifact('999'));
  // A proof with no row behind it.
  store.putProof(withdrawalKey(11), 'withdrawal', artifact('1'));
  // A trusted root covering burns at 1200 inside the leaf window (1000–2000),
  // and one covering w:16's burn at 2500 outside it.
  store.putRoot('0xr1', 1, 1500, 1500, 1);
  store.putRoot('0xr2', 2, 5000, 5000, 1);
}

// --- the run --------------------------------------------------------------------

const PATHS = [
  ...[
    depositKey('1', 1), depositKey('1', 2), depositKey('1', 3), depositKey('137', 4), depositKey('56', 5),
    depositKey('137', 6), withdrawalKey(7), withdrawalKey(8), withdrawalKey(9), withdrawalKey(10),
    depositKey(WAX, 12), withdrawalKey(13), depositKey('1', 14), depositKey('56', 15), withdrawalKey(16),
    withdrawalKey(17),
  ].map((k) => `/v1/transfers/${encodeURIComponent(k)}`),
  '/v1/transfers/nope',
  '/v1/pending',
  ...[
    depositKey('1', 1), depositKey('1', 2), depositKey('1', 3), depositKey('137', 4), depositKey('56', 5),
    depositKey('137', 6), voidKey(7), withdrawalKey(8), withdrawalKey(9), withdrawalKey(10), withdrawalKey(11),
    depositKey(WAX, 12), 'nope',
  ].map((k) => `/v1/proofs/${encodeURIComponent(k)}`),
  '/v1/chains',
  '/v1/routes',
  '/health',
  ...[depositKey('1', 14), withdrawalKey(9), voidKey(7), 'nope'].map((k) => `/v1/activity/${encodeURIComponent(k)}`),
  '/v1/activity?limit=200',
  '/v1/nope',
];

test('the API answers exactly as the golden file says', async () => {
  mock.timers.enable({ apis: ['Date'], now: NOW * 1000 });
  const restore = stubNodes();
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'alcor-api-')), 'indexer.sqlite'));
  seed(store);

  const follower = (id: string, head: number, provableUpTo = -1) => ({
    id,
    state: { at: head, head, caughtUp: true, deposits: 0, frozen: 0, roots: 0, lastError: null, atMovedAt: NOW, provableUpTo, wiring: [], headRaces: 0 },
  });
  const deps = {
    cfg,
    store,
    savanna: {
      state: { at: 5000, head: 5000, caughtUp: true },
      snapshot: () => ({ at: 5000, head: 5000, caughtUp: true, mismatches: 0, leaves: 0, frozen: 0, bytes: 0 }),
      leafStore: { firstBlock: 1000, lastBlock: 2000, read: () => undefined },
    },
    evms: [follower('mainnet', 1005), follower('bsc', 50_000_000), follower('polygon', 70_000_000, 69_999_500)],
    keepers: new Map(),
    histories: [],
    startedAt: NOW * 1000,
  } as unknown as Deps;

  const server = createApi(deps);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const got: Record<string, { status: number; body: unknown }> = {};
  try {
    for (const path of PATHS) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`);
      got[path] = { status: res.status, body: await res.json() };
    }
  } finally {
    server.close();
    store.close();
    restore();
    mock.timers.reset();
  }

  if (process.env.UPDATE_GOLDEN === '1') writeFileSync(GOLDEN, JSON.stringify(got, null, 1) + '\n');
  assert.ok(existsSync(GOLDEN), `no ${GOLDEN}; write it with UPDATE_GOLDEN=1 and review it`);
  assert.deepEqual(got, JSON.parse(readFileSync(GOLDEN, 'utf8')));
});

test('a browser preflight is answered, and only reading is served', async () => {
  const restore = stubNodes();
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'alcor-api-')), 'indexer.sqlite'));
  const server = createApi({ cfg, store, keepers: new Map(), histories: [], startedAt: NOW * 1000 } as unknown as Deps);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/activity`;
    const preflight = await fetch(url, { method: 'OPTIONS' });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), '*');
    assert.equal(preflight.headers.get('access-control-allow-methods'), 'GET, OPTIONS');

    const post = await fetch(url, { method: 'POST', body: '{}' });
    assert.equal(post.status, 405);
    assert.equal(post.headers.get('allow'), 'GET, HEAD, OPTIONS');
    assert.deepEqual(await post.json(), { error: 'POST is not served: this API only reads', code: 'METHOD_NOT_ALLOWED' });
  } finally {
    server.close();
    store.close();
    restore();
  }
});

test('a voided hop bridgeroute opened is served for recover, though no deposit started it', async () => {
  const restore = stubNodes();
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'alcor-api-')), 'indexer.sqlite'));
  // A swap's output sent on to BSC (withdrawal 21), voided; and an older one's way back (31 after 30), voided too.
  store.putHop({ id: 21, prev: null, deposit: null, quantity: '9.000000 USDT', to_domain: '56', to_recipient: '0xabc',
    back_domain: '56', back_recipient: '0xabc', tx: 'tx21', block: 400, at: 4000 });
  store.putHop({ id: 30, prev: null, deposit: null, quantity: '1.000000 USDT', to_domain: '56', to_recipient: '0xdef',
    back_domain: '56', back_recipient: '0xdef', tx: 'tx30', block: 410, at: 4100 });
  store.putHop({ id: 31, prev: 30, deposit: null, quantity: '1.000000 USDT', to_domain: '56', to_recipient: '0xdef',
    back_domain: '56', back_recipient: '0xdef', tx: 'tx31', block: 420, at: 4200 });
  for (const id of [21, 30, 31]) {
    store.upsertTransfer({ key: withdrawalKey(id), direction: 'withdrawal', ref: id, status: 'refunded', src_block: 400, src_time: 4000 });
  }
  const server = createApi({ cfg, store, keepers: new Map(), histories: [], startedAt: NOW * 1000 } as unknown as Deps);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    const body = await (await fetch(`http://127.0.0.1:${port}/v1/hops?recover=true`)).json();
    assert.equal(body.count, 2);
    assert.deepEqual(body.hops.map((h: any) => [h.key, h.legs[0].returning, h.recover.data.id]), [['w:21', false, '21'], ['w:31', true, '31']]);
    assert.deepEqual(body.hops[0].recover, { account: 'hop.alcor', name: 'recover', data: { id: '21' } });
    assert.deepEqual(body.hops[0].legs[0].to, { domain: '56', recipient: '0xabc', chain: 'bsc' });
  } finally {
    server.close();
    store.close();
    restore();
  }
});
