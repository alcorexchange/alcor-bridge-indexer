/**
 * What the NEAR vault holds, read through its view methods: its configuration,
 * the tokens it lists and holds, and the Telos client inside it (the generation
 * it seats, the keys it knows, the roots it trusts).
 *
 * A certificate verifies on NEAR only if every signer's key is known. Unlike on
 * Sui, a key can be learned openly there — `register_key` with the key's proof
 * of possession, which Telos's `regfinkey` history carries — so whoever settles a
 * withdrawal registers the signers the vault does not know yet.
 */
import { nearAddress } from './logs.ts';
import { nearView } from './rpc.ts';

/** One token the vault lists, in the ledger's canonical units (`scale` raw units each). */
export type NearVaultAsset = {
  /** The NEP-141 contract's account id, or NEAR. */
  tokenId: string;
  /** sha256 of `tokenId`, hex: the route's `ext_token` on Telos. */
  token: string;
  scale: bigint;
  minDeposit: bigint;
  /** 0 = no cap. */
  cap: bigint;
  enabled: boolean;
  /** Daily outflow; u64::MAX = unlimited. */
  perPeriod: bigint;
  available: bigint;
  updatedMs: number;
  /** Raw units the vault holds for Telos. */
  held: bigint;
};

export type NearVaultState = {
  vault: string;
  /** sha256 of the vault's account id, hex: the route's vault on Telos. */
  address: string;
  owner: string;
  domain: string;
  depositsPaused: boolean;
  withdrawalsPaused: boolean;
  assets: NearVaultAsset[];
  /** The Telos client inside the vault. */
  client: { generation: number; threshold: bigint };
};

type RawAsset = {
  scale: string; min_deposit: string; cap: string; enabled: boolean;
  per_period: string; available: string; updated_ms: string; held: string;
};

export async function nearVaultState(rpc: string[], vault: string): Promise<NearVaultState> {
  const [cfg, assets, client] = await Promise.all([
    nearView<any>(rpc, vault, 'get_config'),
    nearView<[string, RawAsset][]>(rpc, vault, 'get_assets'),
    nearView<{ generation: number; threshold: string }>(rpc, vault, 'get_client'),
  ]);
  return {
    vault,
    address: String(cfg.vault_address),
    owner: String(cfg.owner),
    domain: String(cfg.domain),
    depositsPaused: Boolean(cfg.deposits_paused),
    withdrawalsPaused: Boolean(cfg.withdrawals_paused),
    assets: assets.map(([tokenId, a]) => ({
      tokenId,
      token: nearAddress(tokenId),
      scale: BigInt(a.scale),
      minDeposit: BigInt(a.min_deposit),
      cap: BigInt(a.cap),
      enabled: Boolean(a.enabled),
      perPeriod: BigInt(a.per_period),
      available: BigInt(a.available),
      updatedMs: Number(a.updated_ms),
      held: BigInt(a.held),
    })),
    client: { generation: Number(client.generation), threshold: BigInt(client.threshold) },
  };
}

const b64 = (hex: string) => Buffer.from(hex.replace(/^0x/, ''), 'hex').toString('base64');

/** Whether the vault's Telos client knows the raw (96-byte) key. */
export const knowsKey = (rpc: string[], vault: string, rawHex: string) =>
  nearView<boolean>(rpc, vault, 'knows_key', { key: b64(rawHex) });

/** Whether the vault's Telos client trusts a finality-tree root (hex). */
export const isTrusted = (rpc: string[], vault: string, rootHex: string) =>
  nearView<boolean>(rpc, vault, 'is_trusted', { root: b64(rootHex) });
