/**
 * The instant-finality block header extension, and the finalizer policy
 * transitions it carries.
 *
 * This is the piece neither predecessor project wrote, and three things block on
 * it: the finality digest on Telos (which needs the *pending* policy's digest
 * and start slot per block — constants on Wire, moving targets on Telos), the
 * `advancePolicy` step on the Ethereum verifier, and retiring the finalizer
 * superset.
 *
 * Layout is from Spring's own sources, not guessed:
 *   block_header.hpp        instant_finality_extension = qc_claim,
 *                           optional<finalizer_policy_diff>,
 *                           optional<proposer_policy_diff>
 *   finalizer_policy.hpp    FC_REFLECT(finalizer_policy_diff,
 *                                      (generation)(threshold)(finalizers_diff))
 *                           FC_REFLECT(finalizers_diff_t,
 *                                      (remove_indexes)(insert_indexes))
 *   finalizer_authority.hpp FC_REFLECT(finalizer_authority,
 *                                      (description)(weight)(public_key))
 *   ordered_diff.hpp        apply_diff: removes first, each index offset by how
 *                           many were already removed; then inserts, ascending.
 *
 * Verified byte-for-byte against Telos mainnet block 487863441.
 */

import { sha256 } from '@noble/hashes/sha2.js';

import { Writer } from '../proof/pack.ts';
import { encodeBlsPublicKeyRaw } from './encoding.ts';

/**
 * Sequential byte reader over an fc::raw::pack stream.
 *
 * Fields are declared explicitly rather than as constructor parameter
 * properties: Node runs the .ts files by stripping types, which erases them
 * without transforming syntax, so parameter properties, enums and namespaces
 * are all unavailable (`erasableSyntaxOnly` in tsconfig.json enforces it).
 */
export class Reader {
  private i = 0;
  private readonly b: Uint8Array;

  constructor(b: Uint8Array) {
    this.b = b;
  }

  get offset(): number {
    return this.i;
  }
  get remaining(): number {
    return this.b.length - this.i;
  }
  /** True when every byte was consumed — the strongest check a parser has. */
  get exhausted(): boolean {
    return this.i === this.b.length;
  }

  private need(n: number): void {
    if (this.i + n > this.b.length) {
      throw new Error(`read past end: need ${n} at ${this.i}, have ${this.b.length}`);
    }
  }

  u8(): number {
    this.need(1);
    return this.b[this.i++];
  }
  u16(): number {
    this.need(2);
    const v = this.b[this.i] | (this.b[this.i + 1] << 8);
    this.i += 2;
    return v;
  }
  u32(): number {
    this.need(4);
    const v =
      (this.b[this.i] |
        (this.b[this.i + 1] << 8) |
        (this.b[this.i + 2] << 16) |
        (this.b[this.i + 3] << 24)) >>>
      0;
    this.i += 4;
    return v;
  }
  u64(): bigint {
    this.need(8);
    let v = 0n;
    for (let k = 7; k >= 0; k--) v = (v << 8n) | BigInt(this.b[this.i + k]);
    this.i += 8;
    return v;
  }
  bool(): boolean {
    return this.u8() !== 0;
  }
  /** LEB128, which is how fc::raw::pack writes a length. */
  varuint32(): number {
    let v = 0;
    let shift = 0;
    for (;;) {
      const b = this.u8();
      v |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
      if (shift > 35) throw new Error('varuint32 too long');
    }
    return v >>> 0;
  }
  bytes(n: number): Uint8Array {
    this.need(n);
    const v = this.b.subarray(this.i, this.i + n);
    this.i += n;
    return v;
  }
  /** A length-prefixed byte string. */
  varbytes(): Uint8Array {
    return this.bytes(this.varuint32());
  }
  string(): string {
    return new TextDecoder().decode(this.varbytes());
  }
  /** `std::optional<T>`: a presence byte, then T. */
  optional<T>(read: () => T): T | undefined {
    return this.bool() ? read() : undefined;
  }
  vector<T>(read: () => T): T[] {
    const n = this.varuint32();
    const out: T[] = new Array(n);
    for (let k = 0; k < n; k++) out[k] = read();
    return out;
  }
}

export type QcClaim = { blockNum: number; isStrongQc: boolean };

export type FinalizerAuthority = {
  description: string;
  weight: bigint;
  /** Raw 96-byte affine little-endian G1, as it appears on the wire. */
  publicKey: Uint8Array;
};

export type OrderedDiff<T> = {
  removeIndexes: number[];
  insertIndexes: Array<[number, T]>;
};

export type FinalizerPolicyDiff = {
  generation: number;
  threshold: bigint;
  finalizersDiff: OrderedDiff<FinalizerAuthority>;
};

export type FinalizerPolicy = {
  generation: number;
  threshold: bigint;
  finalizers: FinalizerAuthority[];
};

export type InstantFinalityExtension = {
  qcClaim: QcClaim;
  finalizerPolicyDiff?: FinalizerPolicyDiff;
  /**
   * Left as raw bytes. Nothing in this bridge needs the proposer schedule, and
   * decoding it would mean carrying the block-signing-authority variant and the
   * K1 key encoding for no gain. It is parsed only far enough to prove the
   * extension was consumed exactly.
   */
  proposerPolicyDiffRaw?: Uint8Array;
};

export const INSTANT_FINALITY_EXTENSION_ID = 2;

function readFinalizerAuthority(r: Reader): FinalizerAuthority {
  const description = r.string();
  const weight = r.u64();
  // The key is a length-prefixed byte string, so 96 bytes arrive as `0x60`
  // followed by the payload. Dropping that prefix when re-packing is the
  // single easiest way to compute a policy digest that is wrong.
  const publicKey = r.varbytes();
  if (publicKey.length !== 96) {
    throw new Error(`finalizer public key must be 96 bytes, got ${publicKey.length}`);
  }
  return { description, weight, publicKey };
}

function readFinalizerPolicyDiff(r: Reader): FinalizerPolicyDiff {
  const generation = r.u32();
  const threshold = r.u64();
  const removeIndexes = r.vector(() => r.u16());
  const insertIndexes = r.vector<[number, FinalizerAuthority]>(() => {
    const at = r.u16();
    return [at, readFinalizerAuthority(r)];
  });
  return { generation, threshold, finalizersDiff: { removeIndexes, insertIndexes } };
}

/**
 * Parse the instant-finality extension payload (header extension id 2).
 *
 * The whole payload must be consumed. A trailing byte means the layout drifted,
 * and a layout that has drifted produces a digest that is well-formed and never
 * verifies — so this is an error, not a warning.
 */
export function parseInstantFinalityExtension(payload: Uint8Array): InstantFinalityExtension {
  const r = new Reader(payload);
  const qcClaim: QcClaim = { blockNum: r.u32(), isStrongQc: r.bool() };
  const finalizerPolicyDiff = r.optional(() => readFinalizerPolicyDiff(r));

  let proposerPolicyDiffRaw: Uint8Array | undefined;
  if (r.bool()) {
    proposerPolicyDiffRaw = payload.subarray(r.offset);
  } else if (!r.exhausted) {
    throw new Error(
      `instant_finality_extension: ${r.remaining} trailing bytes after an absent proposer diff`,
    );
  }

  return { qcClaim, finalizerPolicyDiff, proposerPolicyDiffRaw };
}

/**
 * Apply a finalizer policy diff, exactly as `fc::ordered_diff::apply_diff` does.
 *
 * Removals come first and each index is offset by the number already removed —
 * the indexes describe positions in the *original* list, not in the list as it
 * shrinks. Then insertions, ascending, into the list as it grows. Both
 * sequences must be strictly increasing; the chain asserts on that, so a diff
 * that is not is a diff we misread.
 */
export function applyFinalizerPolicyDiff(
  base: FinalizerPolicy,
  diff: FinalizerPolicyDiff,
): FinalizerPolicy {
  const finalizers = [...base.finalizers];

  diff.finalizersDiff.removeIndexes.forEach((idx, i) => {
    if (i > 0 && idx <= diff.finalizersDiff.removeIndexes[i - 1]) {
      throw new Error('remove_indexes not strictly increasing');
    }
    const at = idx - i;
    if (at >= finalizers.length) {
      throw new Error(`remove index ${idx} - ${i} out of range ${finalizers.length}`);
    }
    finalizers.splice(at, 1);
  });

  diff.finalizersDiff.insertIndexes.forEach(([idx, value], i) => {
    if (i > 0 && idx <= diff.finalizersDiff.insertIndexes[i - 1][0]) {
      throw new Error('insert_indexes not strictly increasing');
    }
    if (idx > finalizers.length) {
      throw new Error(`insert index ${idx} out of range ${finalizers.length}`);
    }
    finalizers.splice(idx, 0, value);
  });

  return { generation: diff.generation, threshold: diff.threshold, finalizers };
}

/** Human-readable form, for comparing against the node's own decode. */
export function describePolicy(p: FinalizerPolicy) {
  return {
    generation: p.generation,
    threshold: Number(p.threshold),
    finalizers: p.finalizers.map((f) => ({
      description: f.description,
      weight: Number(f.weight),
      public_key: encodeBlsPublicKeyRaw(f.publicKey),
    })),
  };
}

/**
 * sha256 over `fc::raw::pack(finalizer_policy)`.
 *
 * `FC_REFLECT(finalizer_policy, (generation)(threshold)(finalizers))` and each
 * finalizer is `(description)(weight)(public_key)`. Two details decide whether
 * this is right:
 *
 *   * the public key is a length-prefixed byte string, so 96 bytes are written
 *     as `0x60` then the payload. Writing the bare 96 bytes yields a plausible
 *     digest that never matches;
 *   * `description` is hashed too, byte for byte. On Telos those are producer
 *     names, so a reconstructed policy carrying the right keys under the wrong
 *     labels still produces the wrong digest.
 *
 * The key is written straight from the 96 raw bytes the diff carried — no
 * decode-and-re-encode round trip, because every conversion is a place to be
 * wrong and the wire form is already the packed form.
 */
export function packFinalizerPolicy(p: FinalizerPolicy): Uint8Array {
  const w = new Writer().u32(p.generation).u64(p.threshold).varuint32(p.finalizers.length);
  for (const f of p.finalizers) w.string(f.description).u64(f.weight).bytes(f.publicKey);
  return w.done();
}

/** The inverse of `packFinalizerPolicy`: every byte consumed, or an error. */
export function unpackFinalizerPolicy(packed: Uint8Array): FinalizerPolicy {
  const r = new Reader(packed);
  const generation = r.u32();
  const threshold = r.u64();
  const finalizers = r.vector(() => readFinalizerAuthority(r));
  if (!r.exhausted) throw new Error(`a packed finalizer policy has ${r.remaining} trailing bytes`);
  return { generation, threshold, finalizers };
}

export function policyDigestBytes(p: FinalizerPolicy): Uint8Array {
  return sha256(packFinalizerPolicy(p));
}

export function policyDigest(p: FinalizerPolicy): string {
  return Buffer.from(policyDigestBytes(p)).toString('hex');
}

/**
 * Writing a finalizer policy down, and reading it back.
 *
 * `JSON.stringify` cannot do either half of this. A policy holds `bigint`
 * weights, which it refuses outright, and 96-byte `Uint8Array` keys, which it
 * turns into `{"0":1,"1":2,…}` — an object that parses back cleanly, is not a
 * Uint8Array, and hashes to something that is merely wrong. The first failure is
 * loud and the second is not, which is why this exists rather than a replacer.
 *
 * The stored shape is deliberately readable: decimal strings for the numbers,
 * hex for the keys.
 */
export type StoredPolicy = {
  generation: number;
  threshold: string;
  finalizers: { description: string; weight: string; publicKey: string }[];
};

export function encodePolicy(policy: FinalizerPolicy): string {
  const stored: StoredPolicy = {
    generation: policy.generation,
    threshold: policy.threshold.toString(),
    finalizers: policy.finalizers.map((f) => ({
      description: f.description,
      weight: f.weight.toString(),
      publicKey: Buffer.from(f.publicKey).toString('hex'),
    })),
  };
  return JSON.stringify(stored);
}

export function decodePolicy(json: string): FinalizerPolicy {
  const stored = JSON.parse(json) as StoredPolicy;
  if (!Array.isArray(stored.finalizers)) {
    throw new Error('stored policy has no finalizer list');
  }
  return {
    generation: stored.generation,
    threshold: BigInt(stored.threshold),
    finalizers: stored.finalizers.map((f) => {
      const key = Buffer.from(f.publicKey, 'hex');
      if (key.length !== 96) {
        throw new Error(
          `stored finalizer key for "${f.description}" is ${key.length} bytes, expected 96`,
        );
      }
      return {
        description: f.description,
        weight: BigInt(f.weight),
        publicKey: new Uint8Array(key),
      };
    }),
  };
}
