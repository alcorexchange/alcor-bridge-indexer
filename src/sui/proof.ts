/**
 * Arguments for `suilightcl` and `suigateway`, built from Sui's public GraphQL.
 *
 * Sui's JSON-RPC is gone; GraphQL serves what a light client needs as BCS:
 * `summaryBcs`, `contentBcs`, `effectsBcs`, `eventBcs`, and the certificate
 * (`validatorSignatures`: the aggregate and the signers' indices). Keys and the
 * signature are turned from Sui's compressed form into the affine
 * little-endian form Telos's BLS host functions take; the contract compresses
 * the keys back and compares, so nothing here is trusted.
 */
import { bls12_381 } from '@noble/curves/bls12-381';

import { fetchJson } from '../net/fetchJson.ts';
import {
  concat,
  contentsEffects,
  effectsHead,
  equalBytes,
  eventsBcs,
  fromB64,
  fromHex,
  hex,
  parseEvents,
  parseSummary,
  suiHash,
  type Summary,
} from './bcs.ts';

export const SUI_GRAPHQL_MAINNET = 'https://graphql.mainnet.sui.io/graphql';

export async function suiGraphql(urls: string[], query: string): Promise<any> {
  let last: unknown;
  for (const url of urls) {
    try {
      const r = await fetchJson(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query }) });
      if (r.errors) throw new Error(`sui graphql: ${JSON.stringify(r.errors).slice(0, 300)}`);
      return r.data;
    } catch (err) {
      last = err;
    }
  }
  throw last;
}

function le48(x: bigint): Uint8Array {
  const out = new Uint8Array(48);
  for (let i = 0; i < 48; i++) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

/** A compressed G2 key (96 B) as Antelope's affine little-endian G2 (192 B). */
export function g2Affine(compressed: Uint8Array): Uint8Array {
  const a = bls12_381.G2.Point.fromHex(compressed).toAffine();
  return concat(le48(a.x.c0), le48(a.x.c1), le48(a.y.c0), le48(a.y.c1));
}

/** A compressed G1 signature (48 B) as Antelope's affine little-endian G1 (96 B). */
export function g1Affine(compressed: Uint8Array): Uint8Array {
  const a = bls12_381.G1.Point.fromHex(compressed).toAffine();
  return concat(le48(a.x), le48(a.y));
}

/** `suilightcl`'s certified_checkpoint, plus what was parsed out of it. */
export type CertifiedCheckpoint = {
  args: { summary: string; signature: string; signers: number[] };
  summary: Summary;
};

export async function certifiedCheckpoint(urls: string[], sequence?: number | bigint): Promise<CertifiedCheckpoint> {
  const at = sequence === undefined ? '' : `(sequenceNumber: ${sequence})`;
  const cp = (await suiGraphql(urls, `{ checkpoint${at} { summaryBcs validatorSignatures { signature signersMap } } }`)).checkpoint;
  if (!cp) throw new Error(`sui: no checkpoint ${sequence ?? '(latest)'}`);
  const bcs = fromB64(cp.summaryBcs);
  return {
    args: {
      summary: hex(bcs),
      signature: hex(g1Affine(fromB64(cp.validatorSignatures.signature))),
      signers: [...(cp.validatorSignatures.signersMap as number[])].sort((a, b) => a - b),
    },
    summary: parseSummary(bcs),
  };
}

/** The sequence number of the last checkpoint of `epoch`, or null while the epoch runs. */
export async function lastCheckpointOf(urls: string[], epoch: number | bigint): Promise<bigint | null> {
  const e = (await suiGraphql(urls, `{ epoch(epochId: ${epoch}) { endTimestamp checkpoints(last: 1) { nodes { sequenceNumber } } } }`)).epoch;
  if (!e?.endTimestamp) return null;
  return BigInt(e.checkpoints.nodes[0].sequenceNumber);
}

/** The committee an end-of-epoch summary names, uncompressed, in its own order. */
export function committeeKeys(summary: Summary): string {
  if (!summary.endOfEpoch) throw new Error('not the last checkpoint of an epoch');
  return hex(concat(...summary.endOfEpoch.committee.map((a) => g2Affine(a.key))));
}

/** Every event of transaction `digest`, in order: GraphQL serves at most 50 a page. */
async function transactionEvents(urls: string[], digest: string): Promise<Uint8Array[]> {
  const out: Uint8Array[] = [];
  let after = '';
  for (;;) {
    const page = (await suiGraphql(urls, `{ transaction(digest: "${digest}") { effects { events(first: 50${after}) {
      pageInfo { endCursor hasNextPage } nodes { eventBcs } } } } }`)).transaction.effects.events;
    out.push(...page.nodes.map((n: any) => fromB64(n.eventBcs)));
    if (!page.pageInfo.hasNextPage) return out;
    after = `, after: "${page.pageInfo.endCursor}"`;
  }
}

/** `suigateway`'s proof of one event: where it is and the bytes down to it. */
export type EventPath = {
  sequence: bigint;
  contents: string;
  effects: string;
  events: string;
  index: number;
  event: number;
};

/**
 * The path from a checkpoint to an event of transaction `digest`, checked here
 * exactly as the gateway will check it, so a proof that would fail on-chain
 * fails first where it is cheap to see why.
 *
 * `pick` is an event's index in the transaction (GraphQL's `sequenceNumber`) —
 * one transaction can hold two deposits — or a predicate on the event type,
 * which takes the first match.
 */
export async function eventPath(urls: string[], digest: string, pick: number | ((type: string) => boolean)): Promise<EventPath> {
  const t = (await suiGraphql(urls, `{ transaction(digest: "${digest}") { effects { effectsBcs checkpoint { sequenceNumber contentBcs summaryBcs } } } }`)).transaction;
  if (!t?.effects?.checkpoint) throw new Error(`sui: transaction ${digest} is not in a checkpoint yet`);
  const effects = fromB64(t.effects.effectsBcs);
  const contents = fromB64(t.effects.checkpoint.contentBcs);
  const summary = parseSummary(fromB64(t.effects.checkpoint.summaryBcs));
  if (!equalBytes(suiHash('CheckpointContents', contents), summary.contentDigest)) throw new Error('contents do not match the summary');

  const index = contentsEffects(contents).findIndex((d) => equalBytes(d.effects, suiHash('TransactionEffects', effects)));
  if (index < 0) throw new Error('the effects are not in their checkpoint');
  const head = effectsHead(effects);
  if (!head.success) throw new Error(`sui: transaction ${digest} failed`);
  if (!head.events) throw new Error(`sui: transaction ${digest} emitted no events`);

  const events = eventsBcs(await transactionEvents(urls, digest));
  if (!equalBytes(suiHash('TransactionEvents', events), head.events)) throw new Error('the events do not match the effects');
  const parsed = parseEvents(events);
  const event = typeof pick === 'number' ? pick : parsed.findIndex((e) => pick(e.type));
  if (event < 0 || event >= parsed.length) throw new Error(`sui: no such event in ${digest}`);
  return { sequence: summary.sequence, contents: hex(contents), effects: hex(effects), events: hex(events), index, event };
}

/** What the Telos side needs to close one vault event, and which event it was. */
export type VaultEventClose = {
  kind: 'credit' | 'voided';
  /** The vault object the event names: a relayer skips any vault but its route's. */
  vault: string;
  sequence: bigint;
  actions: { account: string; name: string; data: Record<string, unknown> }[];
};

/**
 * One Telos transaction for a vault event: `provecp` on the light client for its
 * checkpoint, then the gateway's `credit` (a Deposit) or `voided` (a Voided).
 * Both in one transaction, so the row the gateway reads is there when it reads.
 */
export async function closeVaultEvent(
  urls: string[],
  digest: string,
  event: number,
  accounts: { lightClient: string; gateway: string },
  payer: string,
): Promise<VaultEventClose> {
  const path = await eventPath(urls, digest, event);
  const ev = parseEvents(fromHex(path.events))[path.event];
  const kind = ev.type.endsWith('::vault::Deposit') ? 'credit' : ev.type.endsWith('::vault::Voided') ? 'voided' : null;
  if (!kind) throw new Error(`sui: event ${event} of ${digest} is ${ev.type}, not a vault Deposit or Voided`);
  const cp = await certifiedCheckpoint(urls, path.sequence);
  return {
    kind,
    vault: `0x${hex(ev.contents.subarray(0, 32))}`,
    sequence: path.sequence,
    actions: [
      { account: accounts.lightClient, name: 'provecp', data: { payer, cp: cp.args } },
      {
        account: accounts.gateway,
        name: kind,
        data: { payer, sequence: Number(path.sequence), contents: path.contents, effects: path.effects, events: path.events, index: path.index, event: path.event },
      },
    ],
  };
}
