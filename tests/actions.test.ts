/**
 * Our own history (actions.ts): which actions of a block are kept, with the ABI
 * the contract had in that block, and that bytes another ABI would misread are
 * refused rather than stored as plausible garbage.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ABI, Serializer } from '@wharfkit/antelope';

import { readActions } from '../services/indexer/actions.ts';
import { Store } from '../services/indexer/db.ts';
import { blockTime } from '../src/savanna/ship.ts';
import type { ActionTrace } from '../src/savanna/traces.ts';

const extendedAsset = [{ name: 'quantity', type: 'asset' }, { name: 'contract', type: 'name' }];

/** route.alcor's `opened` as deployed. */
const ROUTE = ABI.from({
  version: 'eosio::abi/1.2',
  structs: [
    { name: 'extended_asset', base: '', fields: extendedAsset },
    {
      name: 'opened',
      base: '',
      fields: [
        { name: 'id', type: 'uint64' },
        { name: 'to', type: 'string' },
        { name: 'back', type: 'string' },
        { name: 'in', type: 'extended_asset' },
        { name: 'least', type: 'extended_asset' },
        { name: 'deadline', type: 'time_point_sec' },
      ],
    },
  ],
  actions: [{ name: 'opened', type: 'opened', ricardian_contract: '' }],
});

/** The ABI from before `to` and `back`: the one a Hyperion host still had on 2026-10-20. */
const STALE = ABI.from({
  version: 'eosio::abi/1.2',
  structs: [
    { name: 'extended_asset', base: '', fields: extendedAsset },
    {
      name: 'opened',
      base: '',
      fields: [
        { name: 'id', type: 'uint64' },
        { name: 'recipient', type: 'name' },
        { name: 'in', type: 'extended_asset' },
        { name: 'least', type: 'extended_asset' },
        { name: 'deadline', type: 'time_point_sec' },
      ],
    },
  ],
  actions: [{ name: 'opened', type: 'opened', ricardian_contract: '' }],
});

const OPENED = {
  id: 1,
  to: 'losezero1234',
  back: '1:0x0d2cdc60dd3ea4ad7c11684ac006a0a64582ddf6',
  in: { quantity: '0.00020000 ETH', contract: 'wrap.alcor' },
  least: { quantity: '27.0064 TLOS', contract: 'eosio.token' },
  deadline: '2026-10-20T01:42:39',
};

const openedBytes = Serializer.encode({ object: OPENED, type: 'opened', abi: ROUTE }).hexString;

let sequence = 100n;
const trace = (account: string, name: string, data: string, receiver = account): ActionTrace => ({
  receiver,
  account,
  name,
  data,
  trxId: `t${sequence}`,
  receipt: {
    receiver,
    actDigest: '00'.repeat(32),
    globalSequence: sequence++,
    recvSequence: 1n,
    authSequence: [],
    codeSequence: 1,
    abiSequence: 1,
  },
});

const setabi = (account: string, abi: ABI) =>
  trace(
    'eosio',
    'setabi',
    Serializer.encode({
      object: { account, abi: Serializer.encode({ object: abi }).array },
      type: 'setabi',
      abi: ABI.from({
        version: 'eosio::abi/1.2',
        structs: [{ name: 'setabi', base: '', fields: [{ name: 'account', type: 'name' }, { name: 'abi', type: 'bytes' }] }],
        actions: [],
      }),
    }).hexString,
  );

const WATCH = { 'route.alcor': ['opened', 'closed'] };

test('only the watched action the account itself received is kept, decoded', () => {
  const { actions, problems } = readActions(
    'telos',
    [
      trace('route.alcor', 'opened', openedBytes),
      // The same action as a notification to someone else, and an action nobody watches.
      trace('route.alcor', 'opened', openedBytes, 'alice'),
      trace('route.alcor', 'exec', '00'),
      trace('eosio.token', 'transfer', '00'),
    ],
    WATCH,
    new Map([['route.alcor', ROUTE]]),
    495000000,
    1792458947,
  );
  assert.deepEqual(problems, []);
  assert.equal(actions.length, 1);
  const [a] = actions;
  assert.deepEqual([a.chain, a.account, a.name, a.block_num, a.time], ['telos', 'route.alcor', 'opened', 495000000, 1792458947]);
  assert.deepEqual(a.data, OPENED);
});

test('bytes the ABI does not describe are refused and named, not stored as garbage', () => {
  const { actions, problems } = readActions('telos', [trace('route.alcor', 'opened', openedBytes)], WATCH, new Map([['route.alcor', STALE]]), 1, 1);
  assert.deepEqual(actions, []);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /route\.alcor::opened/);
});

test('a setabi in the block switches the ABI for every action after it', () => {
  const abis = new Map([['route.alcor', STALE]]);
  const { actions, newAbis, problems } = readActions(
    'telos',
    [setabi('route.alcor', ROUTE), trace('route.alcor', 'opened', openedBytes), setabi('someone.else', STALE)],
    WATCH,
    abis,
    1,
    1,
  );
  assert.deepEqual(problems, []);
  assert.deepEqual(newAbis, ['route.alcor'], 'an account nobody watches is left alone');
  assert.deepEqual(actions[0].data, OPENED);
  assert.deepEqual(JSON.parse(JSON.stringify(abis.get('route.alcor'))), JSON.parse(JSON.stringify(ROUTE)));
});

test('an action of an account with no ABI is named, not dropped silently', () => {
  const { actions, problems } = readActions('wax', [trace('route.alcor', 'opened', openedBytes)], WATCH, new Map(), 1, 1);
  assert.deepEqual(actions, []);
  assert.match(problems[0], /no ABI/);
});

test('a block read twice is stored once, and read back by name and time', () => {
  const store = new Store(':memory:');
  const { actions } = readActions('telos', [trace('route.alcor', 'opened', openedBytes)], WATCH, new Map([['route.alcor', ROUTE]]), 7, 1000);
  store.putActions(actions);
  store.putActions(actions);
  assert.equal(store.actionsOf('telos', 'opened', 0).length, 1);
  assert.deepEqual(store.actionsOf('telos', 'opened', 0)[0].data, OPENED);
  assert.equal(store.actionsOf('telos', 'opened', 1001).length, 0);
  assert.equal(store.actionsOf('wax', 'opened', 0).length, 0);
});

test('a block\'s time is its header slot, half-seconds since 2000', () => {
  const header = Buffer.alloc(8);
  // A block produced at 2026-10-23T09:38:12.500Z: its time is the whole second.
  header.writeUInt32LE((Date.UTC(2026, 9, 23, 9, 38, 12, 500) - Date.UTC(2000, 0, 1)) / 500);
  assert.equal(blockTime(header), Date.UTC(2026, 9, 23, 9, 38, 12) / 1000);
});
