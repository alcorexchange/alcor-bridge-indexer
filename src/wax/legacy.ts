/**
 * Legacy (pre-Savanna) Antelope primitives, as WAX computes them today.
 *
 * Every function here was checked against live WAX blocks in check-ship.ts:
 * the action_mroot rebuilt from SHiP receipts, and the blockroot merkle kept by
 * appending ids, both match the chain.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { PublicKey } from '@wharfkit/antelope';

import { Writer } from '../proof/pack.ts';
import type { ActionTrace } from '../savanna/traces.ts';

export const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
export const unhex = (s: string) => new Uint8Array(Buffer.from(s, 'hex'));

/** A legacy merkle pair: left with the top bit clear, right with it set. */
export const canonical = (l: Uint8Array, r: Uint8Array) => {
  const a = new Uint8Array(l); a[0] &= 0x7f;
  const b = new Uint8Array(r); b[0] |= 0x80;
  return sha256(new Uint8Array([...a, ...b]));
};

/** `merkle()` from Leap: an odd level duplicates its last node. */
export function legacyMerkle(leaves: Uint8Array[]): Uint8Array {
  if (leaves.length === 0) return new Uint8Array(32);
  let level = leaves;
  while (level.length > 1) {
    if (level.length % 2) level = [...level, level[level.length - 1]];
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(canonical(level[i], level[i + 1]));
    level = next;
  }
  return level[0];
}

/** Siblings from the leaf up, in the shape waxgateway folds: bit k of index = right child at level k. */
export function legacyMerklePath(leaves: Uint8Array[], index: number): Uint8Array[] {
  const path: Uint8Array[] = [];
  let level = leaves;
  let i = index;
  while (level.length > 1) {
    if (level.length % 2) level = [...level, level[level.length - 1]];
    path.push(level[i ^ 1]);
    const next: Uint8Array[] = [];
    for (let k = 0; k < level.length; k += 2) next.push(canonical(level[k], level[k + 1]));
    level = next;
    i >>= 1;
  }
  return path;
}

export function foldLegacyPath(leaf: Uint8Array, path: Uint8Array[], index: number): Uint8Array {
  let node = leaf;
  let i = index;
  for (const s of path) {
    node = i & 1 ? canonical(s, node) : canonical(node, s);
    i >>= 1;
  }
  return node;
}

/** fc::raw::pack(action_receipt) -> sha256: the legacy action_mroot leaf. */
export function legacyReceiptDigest(t: ActionTrace): Uint8Array {
  const r = t.receipt!;
  const w = new Writer().name(r.receiver).raw(unhex(r.actDigest)).u64(r.globalSequence).u64(r.recvSequence)
    .varuint32(r.authSequence.length);
  for (const [account, seq] of r.authSequence) w.name(account).u64(seq);
  w.varuint32(r.codeSequence).varuint32(r.abiSequence);
  return sha256(w.done());
}

/**
 * act_digest for an action with no return value:
 *   sha256( sha256(pack(account, name, authorization)) || sha256(pack(data) || 0x00) )
 */
export function actDigest(account: string, name: string, auth: Array<[string, string]>, data: Uint8Array): Uint8Array {
  const base = new Writer().name(account).name(name).varuint32(auth.length);
  for (const [actor, permission] of auth) base.name(actor).name(permission);
  const payload = new Writer().varuint32(data.length).raw(data).varuint32(0);
  return sha256(new Uint8Array([...sha256(base.done()), ...sha256(payload.done())]));
}

/** Leap's incremental_merkle_impl::append, legacy canonical pairs. */
export class LegacyIncrementalMerkle {
  nodes: Uint8Array[];
  count: number;
  constructor(nodes: Uint8Array[], count: number) { this.nodes = nodes; this.count = count; }
  static maxDepth(n: number) { if (n === 0) return 0; let p = 1; while (p < n) p *= 2; return Math.log2(p) + 1; }
  append(d: Uint8Array) {
    let partial = false;
    let depth = LegacyIncrementalMerkle.maxDepth(this.count + 1) - 1;
    let index = this.count;
    let top = d;
    let it = 0;
    const updated: Uint8Array[] = [];
    while (depth > 0) {
      if (index % 2 === 0) {
        if (!partial) updated.push(top);
        top = canonical(top, top);
        partial = true;
      } else {
        const left = this.nodes[it++];
        if (partial) updated.push(left);
        top = canonical(left, top);
      }
      depth--;
      index = Math.floor(index / 2);
    }
    updated.push(top);
    this.nodes = updated;
    this.count++;
  }
  root() { return this.count ? this.nodes[this.nodes.length - 1] : new Uint8Array(32); }
}

/** A producer_authority_schedule as the chain API returns it. */
export type ApiSchedule = {
  version: number;
  producers: Array<{ producer_name: string; authority: [number, { threshold: number; keys: Array<{ key: string; weight: number }> }] }>;
};

/**
 * sha256 of the packed schedule: the last term of every legacy sig_digest, and
 * the hash `producer_schedule_change_extension` carries (checked against the
 * block that proposed v935).
 */
export function scheduleHash(s: ApiSchedule): Uint8Array {
  const w = new Writer().u32(s.version).varuint32(s.producers.length);
  for (const p of s.producers) {
    const [variant, a] = p.authority;
    w.name(p.producer_name).varuint32(variant).u32(a.threshold).varuint32(a.keys.length);
    for (const k of a.keys) w.raw(new Uint8Array([0, ...PublicKey.from(k.key).data.array])).u16(k.weight);
  }
  return sha256(w.done());
}
