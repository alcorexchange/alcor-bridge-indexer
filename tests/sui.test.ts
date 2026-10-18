/**
 * Sui in the registry: its domain, how the environment turns it on, the vault's
 * daily meter as `vault::spend` refills it, and the Move calls a wallet makes to
 * release a withdrawal.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SUI_CHAINS, suiByDomain } from '../src/chains/sui.ts';
import { suiDepositEta, suiWithdrawalEta } from '../src/chains/eta.ts';
import { chainOfDomain, suiChains, type IndexerConfig } from '../services/indexer/config.ts';
import { outflowLeftNow, type VaultAsset } from '../src/sui/client.ts';
import { installPolicyCall, settleCall, SUI_CLOCK } from '../src/sui/withdrawal.ts';

const SUI_DOMAIN = '3856007665771390095';

test("Sui's domain is the first eight bytes of its chain identifier, and classifies as sui", () => {
  const sui = SUI_CHAINS[0];
  assert.equal(sui.domain, SUI_DOMAIN);
  assert.equal(BigInt('0x' + sui.chainId.slice(0, 16)).toString(), SUI_DOMAIN);
  assert.equal(suiByDomain(SUI_DOMAIN)?.id, 'sui');
  const cfg = { sources: [] } as unknown as IndexerConfig;
  assert.equal(chainOfDomain(cfg, SUI_DOMAIN)?.kind, 'sui');
  assert.equal(chainOfDomain(cfg, '1')?.kind, undefined);
});

test('SUI_GRAPHQL turns Sui on, comma-separated', () => {
  assert.deepEqual(suiChains({}), []);
  const [c] = suiChains({ SUI_GRAPHQL: 'https://a/graphql, https://b/graphql' });
  assert.equal(c.chain.id, 'sui');
  assert.deepEqual(c.graphql, ['https://a/graphql', 'https://b/graphql']);
});

test("Sui's timings are seconds both ways, and say they are not measured", () => {
  const sui = SUI_CHAINS[0];
  assert.ok(suiDepositEta(sui).seconds < 60);
  assert.ok(suiWithdrawalEta(sui).seconds < 300);
  assert.equal(suiDepositEta(sui).measured, false);
});

const asset = (over: Partial<VaultAsset>): VaultAsset => ({
  coinType: '0000000000000000000000000000000000000000000000000000000000000002::sui::SUI',
  token: '',
  scale: 10n,
  minDeposit: 0n,
  cap: 0n,
  enabled: true,
  perPeriod: 1000n,
  available: 400n,
  updatedMs: 0,
  held: 0n,
  ...over,
});

test('the daily allowance refills linearly to its ceiling, and an unmetered coin has none', () => {
  assert.equal(outflowLeftNow(asset({}), 0), 400n);
  assert.equal(outflowLeftNow(asset({}), 43_200_000), 900n); // half a day: +500
  assert.equal(outflowLeftNow(asset({}), 86_400_000), 1000n); // capped at the daily figure
  assert.equal(outflowLeftNow(asset({ perPeriod: 2n ** 64n - 1n }), 0), null);
});

test('settle and install calls carry the objects and typed values the Move entry points take', () => {
  const ids = { package: '0xp', telosClient: '0xc', vault: '0xv', coinType: '0x2::sui::SUI' };
  const artifact = {
    vault: '0x' + '11'.repeat(32),
    release: {
      id: '1', domain: SUI_DOMAIN, token: '0x' + '22'.repeat(32), recipient: '0x' + '33'.repeat(32),
      amount: '5', deadline: '9', fee: '0', memo: '0x',
      recvSequence: '7', witness: '0x' + '44'.repeat(32), actionSiblings: [], actionPath: '0',
      majorVersion: 1, minorVersion: 0, blockNum: 10, timestamp: 11, parentTimestamp: 12,
      finalityDigest: '0x' + '55'.repeat(32), treeSiblings: ['0x' + '66'.repeat(32)], treePath: '1',
    },
  };
  const release = settleCall('release', ids, artifact);
  assert.equal(release.target, '0xp::vault::release_entry');
  assert.deepEqual(release.typeArguments, ['0x2::sui::SUI']);
  assert.deepEqual(release.arguments.slice(0, 2), [{ object: '0xv' }, { object: '0xc' }]);
  assert.deepEqual(release.arguments.at(-1), { object: SUI_CLOCK });
  assert.equal(release.arguments.length, 16);
  assert.deepEqual(release.arguments[12], { type: 'vector<u8>', value: '0x' + '55'.repeat(32) });
  assert.deepEqual(release.arguments[14], { type: 'vector<bool>', value: [true] });

  const expire = settleCall('expire', ids, artifact);
  assert.equal(expire.target, '0xp::vault::expire_entry');
  assert.deepEqual(expire.typeArguments, []);

  const install = installPolicyCall('0xp', '0xc', '0xabcd');
  assert.deepEqual(install.arguments, [{ object: '0xc' }, { type: 'vector<u8>', value: '0xabcd' }]);
});
