/**
 * Reading the bridge's own actions out of the stream.
 *
 * Everything a crossing does on the settlement chain passes through one account,
 * so the traces already being decoded for `wdlog` carry the rest of it too: the
 * credit that completes a deposit, the refund that completes a rollback, the
 * claim that hands the tokens to their owner.
 *
 * ## Why not just read the tables
 *
 * Reconciliation does read them, and it is the authority on *what happened*. It
 * is not the authority on *where*: `seen` records a nonce and a time, `wdraws`
 * records a block, and neither records the transaction. A person looking at a
 * crossing wants the hash they can paste into an explorer, on both chains, and
 * the only place it exists is the stream.
 *
 * So the tables stay the safety net and this is the fast path — which is also
 * the right way round for latency, since a block arrives in half a second and a
 * reconciliation pass runs once a minute.
 */

import { ABI, Serializer } from '@wharfkit/antelope';

import type { SavannaChain } from '../../src/chains/savanna.ts';
import type { ActionTrace } from '../../src/savanna/traces.ts';
import type { BlockWdlog } from '../../src/savanna/withdrawalProof.ts';
import { antelopeRpc } from '../../src/net/antelope.ts';
import { uint64ToName } from '../../src/proof/pack.ts';

/** A crossing step seen on the settlement chain, with where to look it up. */
export type BridgeEvent =
  /**
   * A withdrawal bound for an Antelope chain, from its `wdlog`. Read without the
   * ABI — see `antelopeBurns` — so it is recorded even when the ABI is not.
   */
  | {
      kind: 'burn';
      id: bigint;
      domain: bigint;
      /** The route's packed (contract, symbol), bare hex. */
      token: string;
      recipient: string;
      amount: bigint;
      deadline: bigint;
      trxId: string;
    }
  | {
      kind: 'credit';
      /** Which route credited it. A nonce alone names a deposit on every chain. */
      domain: string;
      nonce: number;
      beneficiary: string;
      canonical: bigint;
      /** Non-empty means the bridge parked it for `forward` instead of a claim. */
      memo: string;
      /** The route's token as the ledger keys it: an EVM address, or a packed (contract, symbol). */
      extToken: string;
      trxId: string;
    }
  | { kind: 'forward'; domain: string; nonce: number; trxId: string }
  /** A solver paying a deposit out before its proof: the other way a deposit reaches its beneficiary. */
  | { kind: 'fill'; domain: string; nonce: number; beneficiary: string; trxId: string }
  /**
   * `bridgehop::bind`: withdrawal `id` carries a hop on to `to` on `toDomain`,
   * and goes back to `back` on `backDomain` if the far side voids it. `prev` is
   * the hop it sends back, 0 when a deposit arrived — which is the `forward` or
   * `fill` in the same transaction.
   */
  | {
      kind: 'hop';
      id: number;
      prev: number;
      quantity: string;
      toDomain: string;
      to: string;
      backDomain: string;
      back: string;
      trxId: string;
    }
  | { kind: 'bounce'; domain: string; nonce: number; trxId: string }
  | { kind: 'refund'; id: number; trxId: string }
  | { kind: 'claim'; owner: string; symbolCode: string; trxId: string };

/**
 * The contract's ABI, fetched once.
 *
 * The state-history ABI decodes the trace envelope; the action payloads inside
 * are in the contract's own, and only it knows that the fourth field of `credit`
 * is the nonce. Held for the life of the process: a contract upgrade that
 * changes an action's shape is a redeploy on both sides anyway.
 */
let abiCache: { account: string; abi: ABI } | null = null;

export async function bridgeAbi(chain: SavannaChain): Promise<ABI> {
  const account = chain.accounts.bridge;
  if (abiCache?.account === account) return abiCache.abi;
  const res = await antelopeRpc(chain, '/v1/chain/get_abi', { account_name: account });
  if (!res?.abi) throw new Error(`${account} has no ABI`);
  abiCache = { account, abi: ABI.from(res.abi) };
  return abiCache.abi;
}

/**
 * `bridgehop::bind`, field for field as the contract declares it. Written here rather than fetched: it is the one action read from that
 * contract, and a hop account that is not deployed yet has no ABI to fetch.
 */
const HOP_ABI = ABI.from({
  version: 'eosio::abi/1.2',
  structs: [
    {
      name: 'bind',
      base: '',
      fields: [
        { name: 'id', type: 'uint64' },
        { name: 'prev', type: 'uint64' },
        { name: 'quantity', type: 'asset' },
        { name: 'to_domain', type: 'uint64' },
        { name: 'to', type: 'string' },
        { name: 'back_domain', type: 'uint64' },
        { name: 'back', type: 'string' },
      ],
    },
  ],
  actions: [{ name: 'bind', type: 'bind', ricardian_contract: '' }],
});

/** A hop's `bind`, if `t` is one: only what the hop account itself received. */
function readHop(hopAccount: string | undefined, t: ActionTrace): BridgeEvent | undefined {
  if (!hopAccount || t.account !== hopAccount || t.receiver !== hopAccount || t.name !== 'bind') return undefined;
  const d = Serializer.decode({ data: t.data, type: 'bind', abi: HOP_ABI }) as any;
  return {
    kind: 'hop',
    id: Number(String(d.id)),
    prev: Number(String(d.prev)),
    quantity: String(d.quantity),
    toDomain: String(d.to_domain),
    to: String(d.to),
    backDomain: String(d.back_domain),
    back: String(d.back),
    trxId: t.trxId,
  };
}

/**
 * Every bridge action in a block, decoded, and every hop the hop contract
 * recorded.
 *
 * Only actions the account itself received: an inline notification to a third
 * party carries the same name and would be counted twice.
 */
export function readBridgeEvents(
  abi: ABI,
  bridgeAccount: string,
  traces: ActionTrace[],
  hopAccount?: string,
): BridgeEvent[] {
  const out: BridgeEvent[] = [];

  for (const t of traces) {
    try {
      const hop = readHop(hopAccount, t);
      if (hop) out.push(hop);
    } catch {
      // As below: an unknown shape is not a reason to stop following the chain.
    }
    if (t.account !== bridgeAccount || t.receiver !== bridgeAccount) continue;

    const decode = (): any => Serializer.decode({ data: t.data, type: t.name, abi });

    try {
      switch (t.name) {
        case 'credit': {
          const d = decode();
          out.push({
            kind: 'credit',
            domain: String(d.domain),
            extToken: String(d.ext_token).toLowerCase(),
            nonce: Number(String(d.nonce)),
            beneficiary: String(d.beneficiary),
            canonical: BigInt(String(d.canonical)),
            memo: String(d.memo),
            trxId: t.trxId,
          });
          break;
        }
        case 'forward':
        case 'bounce': {
          const d = decode();
          out.push({
            kind: t.name as 'forward' | 'bounce',
            domain: String(d.domain),
            nonce: Number(String(d.nonce)),
            trxId: t.trxId,
          });
          break;
        }
        case 'fill': {
          const d = decode();
          out.push({
            kind: 'fill',
            domain: String(d.domain),
            nonce: Number(String(d.nonce)),
            beneficiary: String(d.beneficiary),
            trxId: t.trxId,
          });
          break;
        }
        case 'refund': {
          const d = decode();
          out.push({ kind: 'refund', id: Number(String(d.id)), trxId: t.trxId });
          break;
        }
        case 'claim': {
          const d = decode();
          out.push({
            kind: 'claim',
            owner: String(d.owner),
            symbolCode: String(d.sym_code),
            trxId: t.trxId,
          });
          break;
        }
        default:
          break;
      }
    } catch {
      // A shape this build does not know is not a reason to stop following the
      // chain. Reconciliation still sees the result in the tables.
    }
  }
  return out;
}

/**
 * An Antelope-shaped `wdlog`: id 8, domain 8, vault 1+8, token 1+16, recipient
 * 1+8, amount 8, deadline 8, fee 8, memo. Undefined for any other shape.
 */
export function antelopeWdlog(dataHex: string) {
  const d = Buffer.from(dataHex, 'hex');
  if (d.length < 75 || d[16] !== 8 || d[25] !== 16 || d[42] !== 8) return undefined;
  return {
    id: d.readBigUInt64LE(0),
    domain: d.readBigUInt64LE(8),
    token: d.subarray(26, 42).toString('hex'),
    recipient: uint64ToName(d.readBigUInt64LE(43)),
    amount: d.readBigUInt64LE(51),
    deadline: d.readBigUInt64LE(59),
  };
}

/** The block's withdrawals bound for an Antelope chain, as events. */
export function antelopeBurns(wdlogs: BlockWdlog[]): BridgeEvent[] {
  return wdlogs.flatMap((w) => {
    const b = w.frozen ? undefined : antelopeWdlog(w.data);
    return b ? [{ kind: 'burn' as const, ...b, trxId: w.trxId }] : [];
  });
}
