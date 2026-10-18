/**
 * NEAR in the registry: its domains, how the environment turns it on, the
 * vault's log lines (a real testnet deposit), and the function calls a wallet
 * sends to settle a withdrawal or walk a handover.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { NEAR_ACCOUNT, NEAR_CHAINS, nearByDomain } from '../src/chains/near.ts';
import { nearDepositEta, nearWithdrawalEta } from '../src/chains/eta.ts';
import { chainOfDomain, nearChains, type IndexerConfig } from '../services/indexer/config.ts';
import { nearAddress, parseNearLog, type NearDeposit } from '../src/near/logs.ts';
import { CALL_DEPOSIT, CALL_GAS, handoverCalls, settleCalls } from '../src/near/withdrawal.ts';
import { uint64ToName } from '../src/proof/pack.ts';

const MAINNET = '14338890689662875897';
const TESTNET = '15529777497819211366';

test("NEAR's domains are the first eight bytes of each genesis hash, and classify as near", () => {
  const [main, testnet] = NEAR_CHAINS;
  assert.equal(main.domain, MAINNET);
  assert.equal(testnet.domain, TESTNET);
  assert.equal(nearByDomain(MAINNET)?.id, 'near');
  assert.equal(nearByDomain(TESTNET)?.id, 'near-testnet');
  const cfg = { sources: [] } as unknown as IndexerConfig;
  assert.equal(chainOfDomain(cfg, TESTNET)?.kind, 'near');
});

test('NEAR_RPC and NEAR_TESTNET_RPC turn each network on, the tx API defaulting to FastNEAR', () => {
  assert.deepEqual(nearChains({}), []);
  const [t] = nearChains({ NEAR_TESTNET_RPC: 'https://a, https://b' });
  assert.equal(t.chain.id, 'near-testnet');
  assert.deepEqual(t.rpc, ['https://a', 'https://b']);
  assert.equal(t.txApi, 'https://tx.test.fastnear.com');
  const [m] = nearChains({ NEAR_RPC: 'https://m', NEAR_TX_API: 'https://tx.example/' });
  assert.equal(m.chain.id, 'near');
  assert.equal(m.txApi, 'https://tx.example');
});

test("NEAR's timings are seconds both ways, and say they are not measured", () => {
  const near = NEAR_CHAINS[0];
  assert.ok(nearDepositEta(near).seconds < 60);
  assert.ok(nearWithdrawalEta(near).seconds < 300);
  assert.equal(nearDepositEta(near).measured, false);
});

test('account ids: what NEAR accepts, and nothing else', () => {
  const ok = new RegExp(NEAR_ACCOUNT);
  for (const a of ['alice.near', 'vault-1.testnet', 'a1', '0x1111111111111111111111111111111111111111', 'f'.repeat(64)]) {
    assert.ok(ok.test(a), a);
  }
  for (const a of ['A.near', 'a', 'alice..near', '.alice', 'alice.', 'f'.repeat(65)]) assert.ok(!ok.test(a), a);
});

/** A deposit line as contracts/near writes it: borsh of `DepositLog`, hex. */
function depositLine(from: string): string {
  const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const u64 = (v: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(v); return b; };
  const u128 = (v: bigint) => Buffer.concat([u64(v & (2n ** 64n - 1n)), u64(v >> 64n)]);
  const str = (t: string) => Buffer.concat([u32(Buffer.byteLength(t)), Buffer.from(t)]);
  const body = Buffer.concat([
    str('NEAR'), str(from), u128(5n * 10n ** 23n), u64(50_000_000n), u64(3769877376213712896n) /* alcor */,
    u64(0n), str(from), u64(0n), u64(0n), str('near staging 1'),
  ]);
  return `alcor:deposit:${body.toString('hex')}`;
}

test('a deposit line decodes to what the vault locked', () => {
  const d = parseNearLog(depositLine('alice.testnet')) as NearDeposit;
  assert.equal(d.kind, 'deposit');
  assert.equal(d.token, 'NEAR');
  assert.equal(d.from, 'alice.testnet');
  assert.equal(d.raw, 5n * 10n ** 23n);
  assert.equal(d.canonical, 50_000_000n);
  assert.equal(uint64ToName(d.telosTo), 'alcor');
  assert.equal(d.nonce, 0n);
  assert.equal(d.refundTo, 'alice.testnet');
  assert.equal(d.memo.toString(), 'near staging 1');
});

test('the other lines decode, and anything else is not the vault’s', () => {
  const le = (v: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(v); return b.toString('hex'); };
  const str = (s: string) => { const b = Buffer.alloc(4); b.writeUInt32LE(s.length); return b.toString('hex') + Buffer.from(s).toString('hex'); };
  assert.deepEqual(parseNearLog(`alcor:voided:${le(9n)}`), { kind: 'voided', id: 9n });
  assert.deepEqual(parseNearLog(`alcor:released:${le(9n)}${str('bob.near')}${le(5n)}${le(1n)}`),
    { kind: 'released', id: 9n, recipient: 'bob.near', amount: 5n, fee: 1n });
  assert.deepEqual(parseNearLog(`alcor:release_failed:${le(9n)}`), { kind: 'release_failed', id: 9n });
  assert.equal(parseNearLog('EVENT_JSON:{}'), undefined);
  assert.throws(() => parseNearLog(`alcor:voided:${le(9n)}00`), /trailing bytes/);
});

test('every NEAR account is sha256 of its id on Telos', () => {
  assert.equal(nearAddress('NEAR'), 'a9fb8458da311aee6519d6ae4cee1b5265cce0f7a240282992fddf1cd9135796'); // printf NEAR | shasum -a 256
  assert.match(nearAddress('vault-1.testnet'), /^[0-9a-f]{64}$/);
});

const submitRoot = {
  finality: {
    majorVersion: 1, minorVersion: 0, activeGeneration: 197, lastPendingGeneration: 198,
    finalityMroot: '0x' + '01'.repeat(32), lastPendingPolicyDigest: '0x' + '02'.repeat(32), lastPendingPolicyStart: 5,
    reversibleBlocksMroot: '0x' + '03'.repeat(32), qcClaimBlockNum: 6, qcClaimFinalityDigest: '0x' + '04'.repeat(32),
    qcClaimTimestamp: 7, timestamp: 8, baseDigest: '0x' + '05'.repeat(32),
  },
  bits: '0xff',
  signature: '0x' + '00'.repeat(256),
  policyKeys: ['0x' + 'aa'.repeat(32)],
  pending: { policy: '0xabcd', bits: '0x01', signature: '0x' + '00'.repeat(256) },
} as any;

const artifact = {
  vault: '0x' + '11'.repeat(32),
  release: {
    id: '1', domain: TESTNET, token: '0x' + '22'.repeat(32), recipient: '0x' + '33'.repeat(32),
    amount: '5', deadline: '9', fee: '0', memo: '0x',
    recvSequence: '7', witness: '0x' + '44'.repeat(32), actionSiblings: [], actionPath: '0',
    majorVersion: 1, minorVersion: 0, blockNum: 10, timestamp: 11, parentTimestamp: 12,
    finalityDigest: '0x' + '55'.repeat(32), treeSiblings: ['0x' + '66'.repeat(32)], treePath: '1',
  },
};

test('the settling calls: unknown keys first, the root unless trusted, then release or expire', () => {
  const learn = [{ raw: new Uint8Array(96).fill(7), pop: new Uint8Array(192).fill(8) }];
  const calls = settleCalls({
    vault: 'v.testnet', artifact, submitRoot, learn, trusted: false, token: 'NEAR', recipient: null, pastDeadline: false,
  });
  assert.deepEqual(calls.map((c) => c.method), ['register_key', 'submit_root', 'release']);
  for (const c of calls) {
    assert.equal(c.contract, 'v.testnet');
    assert.equal(c.deposit, CALL_DEPOSIT);
    assert.equal(c.gas, CALL_GAS);
  }
  assert.equal(calls[0].args.key, Buffer.alloc(96, 7).toString('base64'));
  const release = calls[2].args as any;
  assert.equal(release.token, 'NEAR');
  assert.equal(release.recipient, null);
  assert.equal(release.proof.recv_sequence, '7');
  assert.deepEqual(release.proof.tree_left, [true]);
  // the wdlog data in the 32-byte shape: id, domain, then vault/token/recipient each with a length of 32
  const data = Buffer.from(release.proof.data, 'base64');
  assert.equal(data.readBigUInt64LE(8).toString(), TESTNET);
  assert.equal(data[16], 32);
  const root = (calls[1].args as any);
  assert.equal(root.finality.active_generation, 197);
  assert.equal(Buffer.from(root.signature, 'base64').length, 192);
  assert.equal(root.pending_policy, Buffer.from('abcd', 'hex').toString('base64'));

  const later = settleCalls({
    vault: 'v.testnet', artifact, submitRoot, learn: [], trusted: true, token: 'NEAR', recipient: 'bob.testnet', pastDeadline: true,
  });
  assert.deepEqual(later.map((c) => c.method), ['expire']);
  assert.deepEqual(Object.keys(later[0].args), ['proof']);
});

test('a handover walks as submit_root then install_policy with its bytes', () => {
  const [root, install] = handoverCalls('v.testnet', submitRoot);
  assert.equal(root.method, 'submit_root');
  assert.equal(install.method, 'install_policy');
  assert.deepEqual(install.args, { packed: Buffer.from('abcd', 'hex').toString('base64') });
});
