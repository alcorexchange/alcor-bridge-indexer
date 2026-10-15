/**
 * The Antelope registry with Vaulta in it: a Savanna chain beside the legacy
 * ones, turned on by its RPC, listed on `/v1/chains` with its light clients'
 * finalizer policies — and WAX listed exactly as before.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ANTELOPE_CHAINS, antelopeByDomain, antelopeById, enabledBy } from '../src/chains/antelope.ts';
import { antelopeDepositEta, antelopeWithdrawalEta } from '../src/chains/eta.ts';
import { chainsStatus } from '../services/indexer/chains.ts';
import { antelopeChains, type IndexerConfig } from '../services/indexer/config.ts';
import { symbolCodeRaw } from '../services/indexer/fast.ts';
import { nameToUint64 } from '../src/proof/pack.ts';

const VAULTA_DOMAIN = '12439917377594391589';
const WAX_DOMAIN = '1181148696416462999';

test('Vaulta is a Savanna chain whose domain is a twenty-digit string, found by that string', () => {
  const vaulta = antelopeById('vaulta')!;
  assert.equal(vaulta.consensus, 'savanna');
  assert.equal(vaulta.domain, VAULTA_DOMAIN);
  assert.equal(typeof vaulta.domain, 'string');
  // Past int64 and past 2^53: through a number it would round.
  assert.ok(BigInt(vaulta.domain) > 2n ** 63n - 1n);
  assert.notEqual(String(Number(vaulta.domain)), VAULTA_DOMAIN);
  assert.equal(antelopeByDomain(VAULTA_DOMAIN)?.id, 'vaulta');
  assert.equal(antelopeByDomain(String(Number(VAULTA_DOMAIN))), undefined);
  // The legacy chains keep their domains.
  assert.equal(antelopeById('wax')!.domain, WAX_DOMAIN);
  assert.equal(antelopeById('xpr')!.domain, '4057084141687023600');
  assert.deepEqual(ANTELOPE_CHAINS.map((c) => [c.id, c.consensus]), [['wax', 'legacy'], ['xpr', 'legacy'], ['vaulta', 'savanna']]);
});

test('a legacy chain is turned on by its state-history socket, Vaulta by its RPC, and only Vaulta has no keeper', () => {
  assert.deepEqual(ANTELOPE_CHAINS.map(enabledBy), ['WAX_SHIP_URL', 'XPR_SHIP_URL', 'VAULTA_RPC']);

  assert.deepEqual(antelopeChains({}, 'data'), []);
  // The relayers' socket for Vaulta does not make the indexer read it.
  assert.deepEqual(antelopeChains({ VAULTA_SHIP_URL: 'ws://127.0.0.1:1113' }, 'data'), []);

  const [vaulta] = antelopeChains({ VAULTA_RPC: 'http://127.0.0.1:1111' }, 'data');
  assert.equal(vaulta.chain.id, 'vaulta');
  assert.equal(vaulta.rpc, 'http://127.0.0.1:1111');
  assert.deepEqual(vaulta.history, ['https://eos.eosusa.io', 'https://eos.hyperion.eosrio.io']);
  assert.equal(vaulta.keeper, undefined);

  const both = antelopeChains({ WAX_SHIP_URL: 'ws://127.0.0.1:2224', VAULTA_RPC: 'http://n:1111', VAULTA_HISTORY: 'https://a, https://b' }, '/data');
  assert.deepEqual(both.map((a) => a.chain.id), ['wax', 'vaulta']);
  assert.equal(both[0].rpc, 'https://wax.eosusa.io');
  assert.deepEqual(both[0].keeper && { ship: both[0].keeper.ship, dir: both[0].keeper.dir, seed: both[0].keeper.seedFile }, {
    ship: 'ws://127.0.0.1:2224',
    dir: '/data/wax',
    seed: 'data/wax-blockroot-seed.json',
  });
  assert.deepEqual(both[1].history, ['https://a', 'https://b']);
});

test('Vaulta\'s timings are seconds both ways, and say they are not measured yet', () => {
  const vaulta = antelopeById('vaulta')!;
  const wax = antelopeById('wax')!;
  const deposit = antelopeDepositEta(vaulta);
  const withdrawal = antelopeWithdrawalEta(vaulta);
  assert.equal(deposit.measured, false);
  assert.equal(withdrawal.measured, false);
  assert.ok(deposit.seconds < 30 && withdrawal.seconds < 30);
  assert.ok(deposit.seconds < antelopeDepositEta(wax).seconds);
  assert.deepEqual(deposit.parts.map((p) => p.what), ['Vaulta finalizers certify the block', 'the relayer proves it on Telos']);
  assert.deepEqual(withdrawal.parts.map((p) => p.what), ['Telos finalizes the burn', 'the relayer releases it on Vaulta']);
  // WAX's are unchanged.
  assert.equal(antelopeDepositEta(wax).measured, true);
  assert.equal(antelopeWithdrawalEta(wax).parts.length, 3);
});

// --- /v1/chains, against stubbed nodes ------------------------------------------

/** A name as the ledger packs it into `vault` and `ext_token`: eight bytes, little-endian. */
function packed(name: string): string {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(nameToUint64(name));
  return b.toString('hex');
}

/** An Antelope token as `ext_token`: contract, precision, up to seven letters. */
const extToken = (contract: string, precision: number, code: string) =>
  packed(contract) + Buffer.from([precision, ...Buffer.from(code.padEnd(7, '\0'))]).toString('hex');

const route = (id: number, domain: string, gateway: string, sym: string, contract: string) => ({
  id,
  domain,
  vault: packed('bridge.alcor'),
  gateway,
  asset_id: symbolCodeRaw(sym),
  ext_token: extToken(contract, Number(sym.split(',')[0]), sym.split(',')[1]),
  min_deposit: '100000',
  cap: '0',
  scale: '1',
  backing: '5000000',
  max_withdrawal: '10000000',
  optimistic_max: '0',
  min_confirmations: 0,
  deposits_open: 1,
  withdrawals_open: 1,
});

const seat = { weight: 1, key: 'aa' };
type Tables = Record<string, unknown[]>;

/** What each node answers: tables by `<code>/<table>`, and the chain endpoints. */
const NODES: Record<string, { tables: Tables; calls: Record<string, unknown> }> = {
  'telos.test': {
    tables: {
      'bridge.alcor/routes': [
        route(20, VAULTA_DOMAIN, 'vlt.g.alcor', '4,A', 'core.vaulta'),
        route(10, WAX_DOMAIN, 'wax.g.alcor', '8,WAX', 'eosio.token'),
      ],
      'bridge.alcor/assets': [{ sym: '4,A' }, { sym: '8,WAX' }],
      'bridge.alcor/spokes': [],
      'vlt.g.alcor/config': [{ bridge: 'bridge.alcor', light_client: 'vlt.lc.alcor', vault: 'bridge.alcor', domain: VAULTA_DOMAIN }],
      'vlt.lc.alcor/policy': [{ generation: 321, threshold: 15, seats: [seat], digest: '00' }],
      'vlt.lc.alcor/blocks': [{ version: 1, block_num: 525000000, id: 'ab', finality_mroot: 'cd', signers: 21, payer: 'relay.alcor' }],
      'wax.g.alcor/config': [{ bridge: 'bridge.alcor', light_client: 'wax.lc.alcor', vault: 'bridge.alcor', domain: WAX_DOMAIN }],
      'wax.lc.alcor/core': [{ version: 7, keys: ['k'] }],
      'wax.lc.alcor/blocks': [{ version: 1, block_num: 400000000, id: 'ef', action_mroot: '01', signers: 6, payer: 'relay.alcor' }],
    },
    calls: {
      '/v1/chain/get_finalizer_info': { active_finalizer_policy: { generation: 185 }, pending_finalizer_policy: null },
      '/v1/chain/get_producer_schedule': { active: { version: 5 }, pending: null, proposed: null },
    },
  },
  'vaulta.test': {
    tables: {
      'bridge.alcor/config': [{ light_client: 'tls.lc.alcor', telos_bridge: 'bridge.alcor', domain: VAULTA_DOMAIN, paused: 0, next_deposit: 2 }],
      // One generation behind Telos's newest: the relayer has a transition to prove.
      'tls.lc.alcor/policy': [{ generation: 184, threshold: 15, seats: [seat], digest: '00' }],
    },
    calls: {
      '/v1/chain/get_info': { head_block_num: 525000100 },
      '/v1/chain/get_finalizer_info': { active_finalizer_policy: { generation: 321 }, pending_finalizer_policy: null },
    },
  },
  'wax.test': {
    tables: {
      'bridge.alcor/config': [{ light_client: 'tls.lc.alcor', telos_bridge: 'bridge.alcor', domain: WAX_DOMAIN, paused: 0, next_deposit: 2 }],
      'tls.lc.alcor/policy': [{ version: 5, producers: [{ producer_name: 'p' }] }],
    },
    calls: {
      '/v1/chain/get_info': { head_block_num: 400000050 },
      '/v1/chain/get_producer_schedule': { active: { version: 7 } },
    },
  },
};

function stubNodes(): () => void {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL, init?: { body?: string }) => {
    const url = new URL(String(input));
    const node = NODES[url.host];
    if (!node) throw new Error(`no stub for ${url.host}`);
    let body: unknown;
    if (url.pathname === '/v1/chain/get_table_rows') {
      const q = JSON.parse(init?.body ?? '{}');
      const rows = node.tables[`${q.code}/${q.table}`] ?? [];
      body = { rows: q.reverse ? [...rows].reverse().slice(0, q.limit) : rows, more: false, next_key: '' };
    } else {
      body = node.calls[url.pathname];
      if (body === undefined) return new Response('{}', { status: 400 });
    }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = real;
  };
}

const cfg = {
  savanna: { id: 'telos-production', rpc: ['http://telos.test'], accounts: { bridge: 'bridge.alcor' } },
  accounts: { bridge: 'bridge.alcor' },
  sources: [],
  antelope: antelopeChains({ WAX_SHIP_URL: 'ws://unused', WAX_RPC: 'http://wax.test', VAULTA_RPC: 'http://vaulta.test' }, 'data'),
} as unknown as IndexerConfig;

test('/v1/chains lists Vaulta with its finalizer policies, and WAX as before', async () => {
  const restore = stubNodes();
  try {
    const status = await chainsStatus(cfg, {}, new Map());
    const [wax, vaulta] = status.sources as any[];

    assert.equal(vaulta.error, undefined);
    assert.equal(vaulta.id, 'vaulta');
    assert.equal(vaulta.name, 'Vaulta');
    assert.equal(vaulta.kind, 'antelope');
    assert.equal(vaulta.domain, VAULTA_DOMAIN);
    assert.equal(vaulta.strategy, 'savanna');
    assert.deepEqual(vaulta.lightClient, { account: 'vlt.lc.alcor', contract: 'tls.lc.alcor' });
    assert.equal(vaulta.gateway, 'vlt.g.alcor');
    assert.deepEqual(vaulta.contracts, { vault: 'bridge.alcor', withdrawals: 'bridge.alcor', mirror: null });
    assert.deepEqual(vaulta.provedTop, { block: 525000000, hash: 'ab', at: '', signers: 21 });
    assert.equal(vaulta.head, 525000100);
    assert.equal(vaulta.behind, 100);
    assert.deepEqual(vaulta.upkeep, {
      kind: 'finalizer policies',
      note: vaulta.upkeep.note,
      vaultaOnTelos: { held: 321, active: 321, lag: 0 },
      telosOnVaulta: { held: 184, active: 185, lag: 1 },
      keeper: null,
    });
    assert.deepEqual(vaulta.active, { deposits: true, withdrawals: true });
    assert.equal(vaulta.timing.deposit.measured, false);
    assert.equal(vaulta.routes.length, 1);
    assert.equal(vaulta.routes[0].symbol, 'A');
    assert.deepEqual(vaulta.routes[0].antelopeToken, { contract: 'core.vaulta', symbol: 'A', precision: 4 });
    assert.equal(vaulta.routes[0].withdrawMemo, `${VAULTA_DOMAIN}:<account>`);

    // WAX: the same fields, read the legacy way.
    assert.equal(wax.error, undefined);
    assert.equal(wax.strategy, 'producers');
    assert.deepEqual(wax.lightClient, { account: 'wax.lc.alcor', contract: 'tls.lc.alcor' });
    assert.deepEqual(wax.upkeep, {
      kind: 'producer schedules',
      note: 'both light clients learn schedule changes from proofs; a lag here means the relayer has not proved the change yet',
      waxOnTelos: { held: 7, active: 7, lag: 0 },
      telosOnWax: { held: 5, active: 5, lag: 0 },
      keeper: null,
    });
    assert.deepEqual(wax.active, { deposits: true, withdrawals: true });
    assert.equal(wax.timing.deposit.measured, true);
  } finally {
    restore();
  }
});

test('a Vaulta light client without a policy closes its direction and says which', async () => {
  const held = NODES['vaulta.test'].tables['tls.lc.alcor/policy'];
  NODES['vaulta.test'].tables['tls.lc.alcor/policy'] = [];
  const restore = stubNodes();
  try {
    const status = await chainsStatus({ ...cfg, antelope: cfg.antelope.filter((a) => a.chain.id === 'vaulta') }, {}, new Map());
    const [vaulta] = status.sources as any[];
    assert.equal(vaulta.active.deposits, true);
    assert.equal(vaulta.active.withdrawals, false);
    assert.equal(vaulta.active.reason, 'the Telos light client on Vaulta is not bootstrapped');
    assert.equal(vaulta.upkeep.telosOnVaulta, null);
  } finally {
    restore();
    NODES['vaulta.test'].tables['tls.lc.alcor/policy'] = held;
  }
});
