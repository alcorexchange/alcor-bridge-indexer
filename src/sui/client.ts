/**
 * What the Sui package's `telos_client::TelosClient` holds, read over GraphQL:
 * the generation it seats and which finalizer keys it knows.
 *
 * A certificate verifies on Sui only if every signer is a known key, and Sui has
 * no open way to learn one (no proof of possession in Move). So whoever settles
 * a withdrawal first checks that the signers are known and, if not, walks the
 * handovers that brought the new keys in (scripts/sui-advance-policy.ts).
 */
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
