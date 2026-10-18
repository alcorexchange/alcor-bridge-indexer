/**
 * Sui's BCS, as far as a light client reads it: the checkpoint summary, the
 * checkpoint contents, a transaction's effects and events.
 *
 * The off-chain twin of `include/alcor/sui.hpp` in the bridge repository, and
 * as strict: a variant it does not know, bytes left over, or a length past the
 * end is an error. Every digest is blake2b-256 over "TypeName::" ‖ bcs.
 */
import { blake2b } from '@noble/hashes/blake2b';

export const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
export const fromHex = (s: string) => new Uint8Array(Buffer.from(s.replace(/^0x/, ''), 'hex'));
export const fromB64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));
export const equalBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) {
    out.set(p, i);
    i += p.length;
  }
  return out;
}

export function uleb(n: number): Uint8Array {
  const out: number[] = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return new Uint8Array(out);
}

/** Sui's digest of a `BcsSignable` value. */
export function suiHash(typeName: string, bcs: Uint8Array): Uint8Array {
  return blake2b(concat(new TextEncoder().encode(`${typeName}::`), bcs), { dkLen: 32 });
}

/** Sui prints digests in base58. */
export function base58(bytes: Uint8Array): string {
  const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = BigInt(`0x${hex(bytes) || '0'}`);
  let out = '';
  while (n > 0n) {
    out = A[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return out;
}

export class Reader {
  i = 0;
  readonly b: Uint8Array;
  constructor(b: Uint8Array) {
    this.b = b;
  }
  need(k: number) {
    if (this.i + k > this.b.length) throw new Error('bcs: out of bytes');
  }
  done() {
    return this.i === this.b.length;
  }
  u8() {
    this.need(1);
    return this.b[this.i++];
  }
  u32() {
    this.need(4);
    const v = new DataView(this.b.buffer, this.b.byteOffset + this.i, 4).getUint32(0, true);
    this.i += 4;
    return v;
  }
  u64() {
    this.need(8);
    const v = new DataView(this.b.buffer, this.b.byteOffset + this.i, 8).getBigUint64(0, true);
    this.i += 8;
    return v;
  }
  uleb() {
    let v = 0;
    for (let shift = 0; shift < 35; shift += 7) {
      const b = this.u8();
      v += (b & 0x7f) * 2 ** shift;
      if (!(b & 0x80)) return v;
    }
    throw new Error('bcs: uleb128 too long');
  }
  option() {
    const tag = this.u8();
    if (tag > 1) throw new Error('bcs: bad option tag');
    return tag === 1;
  }
  take(k: number) {
    this.need(k);
    const out = this.b.subarray(this.i, this.i + k);
    this.i += k;
    return out;
  }
  bytes() {
    return this.take(this.uleb());
  }
  digest() {
    if (this.uleb() !== 32) throw new Error('bcs: a digest must be 32 bytes');
    return this.take(32);
  }
  str() {
    return new TextDecoder().decode(this.bytes());
  }
}

export type Authority = { key: Uint8Array; stake: bigint };

export type Summary = {
  epoch: bigint;
  sequence: bigint;
  networkTotalTransactions: bigint;
  contentDigest: Uint8Array;
  timestampMs: bigint;
  endOfEpoch: { committee: Authority[]; protocolVersion: bigint } | null;
};

function skipCommitments(r: Reader) {
  for (let k = r.uleb(); k > 0; k--) {
    if (r.uleb() > 1) throw new Error('unknown checkpoint commitment variant');
    r.digest();
  }
}

export function parseSummary(bcs: Uint8Array): Summary {
  const r = new Reader(bcs);
  const epoch = r.u64();
  const sequence = r.u64();
  const networkTotalTransactions = r.u64();
  const contentDigest = r.digest();
  if (r.option()) r.digest();
  r.take(32);
  const timestampMs = r.u64();
  skipCommitments(r);
  let endOfEpoch: Summary['endOfEpoch'] = null;
  if (r.option()) {
    const committee = Array.from({ length: r.uleb() }, () => ({ key: r.bytes(), stake: r.u64() }));
    const protocolVersion = r.u64();
    skipCommitments(r);
    endOfEpoch = { committee, protocolVersion };
  }
  r.bytes();
  if (!r.done()) throw new Error('trailing bytes after the checkpoint summary');
  return { epoch, sequence, networkTotalTransactions, contentDigest, timestampMs, endOfEpoch };
}

/** Effects digests of a V2 `CheckpointContents`, in order, parsed whole. */
export function contentsEffects(bcs: Uint8Array): { transaction: Uint8Array; effects: Uint8Array }[] {
  const r = new Reader(bcs);
  if (r.uleb() !== 1) throw new Error('checkpoint contents must be V2');
  const out = Array.from({ length: r.uleb() }, () => {
    const d = { transaction: r.digest(), effects: r.digest() };
    for (let k = r.uleb(); k > 0; k--) {
      r.bytes();
      if (r.option()) r.u64();
    }
    return d;
  });
  if (!r.done()) throw new Error('trailing bytes after the checkpoint contents');
  return out;
}

/** V2 effects up to `events_digest`; null events when it emitted none. */
export function effectsHead(bcs: Uint8Array): { success: boolean; transaction: Uint8Array | null; events: Uint8Array | null } {
  const r = new Reader(bcs);
  if (r.uleb() !== 1) throw new Error('transaction effects must be V2');
  if (r.uleb() !== 0) return { success: false, transaction: null, events: null };
  r.u64();
  r.take(32);
  const transaction = r.digest();
  if (r.option()) r.u32();
  return { success: true, transaction, events: r.option() ? r.digest() : null };
}

export type SuiEvent = {
  package: Uint8Array;
  module: string;
  sender: Uint8Array;
  type: string;
  typeParams: number;
  contents: Uint8Array;
};

function typeTag(r: Reader, depth: number): string {
  if (depth >= 16) throw new Error('type tag nested too deep');
  const t = r.uleb();
  const names = ['bool', 'u8', 'u64', 'u128', 'address', 'signer'];
  if (t < 6) return names[t];
  if (t === 6) return `vector<${typeTag(r, depth + 1)}>`;
  if (t === 7) return structTag(r, depth + 1).text;
  if (t <= 10) return ['u16', 'u32', 'u256'][t - 8];
  throw new Error('unknown type tag');
}

function structTag(r: Reader, depth: number) {
  const address = r.take(32);
  const module = r.str();
  const name = r.str();
  const n = r.uleb();
  const params = Array.from({ length: n }, () => typeTag(r, depth));
  return { address, module, name, params: n, text: `0x${hex(address)}::${module}::${name}${n ? `<${params.join(', ')}>` : ''}` };
}

/** A `TransactionEvents` (Vec<Event>) parsed whole. */
export function parseEvents(bcs: Uint8Array): SuiEvent[] {
  const r = new Reader(bcs);
  const out = Array.from({ length: r.uleb() }, () => {
    const pkg = r.take(32);
    const module = r.str();
    const sender = r.take(32);
    const t = structTag(r, 0);
    return { package: pkg, module, sender, type: t.text, typeParams: t.params, contents: r.bytes() };
  });
  if (!r.done()) throw new Error('trailing bytes after the transaction events');
  return out;
}

/** The BCS of `TransactionEvents` from its events' own BCS, as GraphQL serves them one by one. */
export function eventsBcs(events: Uint8Array[]): Uint8Array {
  return concat(uleb(events.length), ...events);
}
