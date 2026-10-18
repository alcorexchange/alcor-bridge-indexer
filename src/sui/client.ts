/**
 * What the Sui package's objects hold, read over GraphQL: the Telos client (the
 * generation it seats, which finalizer keys it knows) and the vault (who it
 * trusts, whether it is open, the coins it lists and holds).
 *
 * A certificate verifies on Sui only if every signer is a known key, and Sui has
 * no open way to learn one (no proof of possession in Move). So whoever settles
 * a withdrawal first checks that the signers are known and, if not, walks the
 * handovers that brought the new keys in (scripts/sui-advance-policy.ts).
 */
import { createHash } from 'node:crypto';

import { concat, fromHex, uleb } from './bcs.ts';
import { suiGraphql } from './proof.ts';

export type ClientState = {
  generation: number;
  threshold: bigint;
  /** The object id of the `keys` table: its entries are dynamic fields named by keccak256(raw key). */
  keysTable: string;
};

export async function clientState(urls: string[], client: string): Promise<ClientState> {
  const o = (await suiGraphql(urls, `{ object(address: "${client}") { asMoveObject { contents { json } } } }`)).object;
  const json = o?.asMoveObject?.contents?.json;
  if (!json?.keys?.id) throw new Error(`sui: ${client} is not a TelosClient`);
  return { generation: Number(json.generation), threshold: BigInt(json.threshold), keysTable: json.keys.id };
}

/** The ids (keccak256 of raw keys, 0x-hex) among `ids` the client does not know. */
export async function unknownKeys(urls: string[], keysTable: string, ids: string[]): Promise<string[]> {
  const unique = [...new Set(ids.map((id) => id.toLowerCase()))];
  const unknown: string[] = [];
  for (let i = 0; i < unique.length; i += 25) {
    const batch = unique.slice(i, i + 25);
    const fields = batch.map((id, j) => {
      const name = Buffer.from(concat(uleb(32), fromHex(id))).toString('base64');
      return `k${j}: dynamicField(name: { type: "vector<u8>", bcs: "${name}" }) { __typename }`;
    });
    const a = (await suiGraphql(urls, `{ address(address: "${keysTable}") { ${fields.join(' ')} } }`)).address;
    batch.forEach((id, j) => { if (!a?.[`k${j}`]) unknown.push(id); });
  }
  return unknown;
}

/** One coin the vault lists, in the ledger's canonical units (`scale` raw units each). */
export type VaultAsset = {
  /** The coin type as `type_name::with_original_ids` prints it: no 0x, full-width address. */
  coinType: string;
  /** sha256 of `coinType`, hex: the route's `ext_token` on Telos. */
  token: string;
  scale: bigint;
  minDeposit: bigint;
  /** 0 = no cap. */
  cap: bigint;
  enabled: boolean;
  /** Daily outflow; u64::MAX = unlimited. */
  perPeriod: bigint;
  /** What the meter allows now, before refilling since `updatedMs`. */
  available: bigint;
  updatedMs: number;
  /** Raw units the vault holds. */
  held: bigint;
};

export type VaultState = {
  vault: string;
  /** The package that defines the vault: its ORIGINAL id (types keep it across upgrades). */
  package: string;
  telosClient: string;
  domain: string;
  depositsPaused: boolean;
  withdrawalsPaused: boolean;
  assets: VaultAsset[];
};

async function dynamicFields(urls: string[], parent: string): Promise<{ name: any; value: any }[]> {
  const out: { name: any; value: any }[] = [];
  let after = '';
  for (;;) {
    const page = (await suiGraphql(urls, `{ address(address: "${parent}") { dynamicFields(first: 50${after}) {
      pageInfo { endCursor hasNextPage } nodes { name { json } value { ... on MoveValue { json } } } } } }`)).address.dynamicFields;
    out.push(...page.nodes.map((n: any) => ({ name: n.name.json, value: n.value?.json })));
    if (!page.pageInfo.hasNextPage) return out;
    after = `, after: "${page.pageInfo.endCursor}"`;
  }
}

/** The vault object as it stands: who it trusts, whether it is open, and every coin it lists. */
export async function vaultState(urls: string[], vault: string): Promise<VaultState> {
  const o = (await suiGraphql(urls, `{ object(address: "${vault}") { asMoveObject { contents { type { repr } json } } } }`)).object;
  const contents = o?.asMoveObject?.contents;
  if (!contents?.type?.repr?.endsWith('::vault::Vault')) throw new Error(`sui: ${vault} is not a bridge vault`);
  const j = contents.json;
  const [assets, balances] = await Promise.all([dynamicFields(urls, j.assets.id), dynamicFields(urls, j.balances.id)]);
  const held = new Map(balances.map((b) => [String(b.name), BigInt(b.value)]));
  return {
    vault,
    package: contents.type.repr.split('::')[0],
    telosClient: j.client,
    domain: String(j.domain),
    depositsPaused: Boolean(j.deposits_paused),
    withdrawalsPaused: Boolean(j.withdrawals_paused),
    assets: assets.map(({ name, value: a }) => ({
      coinType: String(name),
      token: createHash('sha256').update(String(name)).digest('hex'),
      scale: BigInt(a.scale),
      minDeposit: BigInt(a.min_deposit),
      cap: BigInt(a.cap),
      enabled: Boolean(a.enabled),
      perPeriod: BigInt(a.per_period),
      available: BigInt(a.available),
      updatedMs: Number(a.updated_ms),
      held: held.get(String(name)) ?? 0n,
    })),
  };
}

const U64_MAX = 2n ** 64n - 1n;
const PERIOD_MS = 86_400_000n;

/** The vault's daily allowance left for `a` at `nowMs`, canonical units, refilled as `vault::spend` does; null when unmetered. */
export function outflowLeftNow(a: Pick<VaultAsset, 'perPeriod' | 'available' | 'updatedMs'>, nowMs: number): bigint | null {
  if (a.perPeriod === U64_MAX) return null;
  const topped = a.available + (a.perPeriod * BigInt(Math.max(0, nowMs - a.updatedMs))) / PERIOD_MS;
  return topped > a.perPeriod ? a.perPeriod : topped;
}
