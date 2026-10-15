/**
 * BEP-126 fast-finality votes: parsing, verification, and the shape the Antelope
 * light client takes them in.
 *
 * A vote is an aggregate BLS12-381 signature over four fields, carried in the
 * `extraData` of a header. Two things about it were established against live
 * Chapel and mainnet data rather than read off a spec, and both are load-bearing:
 * the signed message is `keccak(rlp[srcNum, srcHash, tgtNum, tgtHash])`, and the
 * DST is Ethereum's POP tag, not Savanna's NUL one.
 *
 * The rule that finalizes anything: a justified target whose source is its direct
 * parent finalizes that source. A vote spanning more than one block proves
 * justification only, and both this module and the contract refuse it.
 */

import { RLP } from '@ethereumjs/rlp';
import { keccak_256 } from '@noble/hashes/sha3';

import { encodeG1ToAntelope, encodeG2ToAntelope } from '../savanna/encoding.ts';
import { fastAggregateVerify } from '../savanna/aggregate.ts';
import { ETH_DST } from '../savanna/ciphersuite.ts';
import { hexToBytes, toHex, type EncodedHeader } from './header.ts';

/** extraData: vanity | [epoch: count | count*ENTRY | turnLength] | vote | seal. */
export const VANITY = 32;
export const SEAL = 65;
/** One validator in an epoch header: 20-byte consensus address, 48-byte vote key. */
export const ENTRY = 68;

export type Validator = { address: string; pubkey: Uint8Array };

export type VoteAttestation = {
  /** Parlia's VoteAddressSet: bit i is the i-th validator of the sorted set. */
  bitset: bigint;
  /** The aggregate, compressed G2 (96 bytes). */
  signature: Uint8Array;
  sourceNumber: number;
  sourceHash: Uint8Array;
  targetNumber: number;
  targetHash: Uint8Array;
};

const num = (b: Uint8Array): number => Number(BigInt(b.length ? toHex(b) : '0x0'));

/** Where the vote starts: after the validator block and turnLength on an epoch header. */
function voteOffset(extra: Uint8Array): number {
  const announced = extra[VANITY];
  const withSet = VANITY + 1 + announced * ENTRY;
  // BEP-341 put a turnLength byte after the validator block. An epoch header is
  // recognised by there being room for the whole block plus the seal.
  return extra.length > withSet + SEAL ? withSet + 1 : VANITY;
}

export function parseAttestation(extraData: string): VoteAttestation {
  const extra = hexToBytes(extraData);
  if (extra.length <= VANITY + SEAL) throw new Error('extraData carries no vote');
  const body = extra.subarray(voteOffset(extra), extra.length - SEAL);
  const [set, signature, data] = RLP.decode(body) as unknown as [
    Uint8Array,
    Uint8Array,
    Uint8Array[],
  ];
  if (signature.length !== 96) throw new Error(`aggregate signature is ${signature.length} bytes`);
  return {
    bitset: BigInt(set.length ? toHex(set) : '0x0'),
    signature,
    sourceNumber: num(data[0]),
    sourceHash: data[1],
    targetNumber: num(data[2]),
    targetHash: data[3],
  };
}

/**
 * The validator set an epoch header announces.
 *
 * Addresses must ascend strictly: a vote's bitset indexes this list, so the
 * order is part of the protocol, and duplicates would let one validator fill two
 * slots of a quorum.
 */
export function parseValidators(extraData: string): Validator[] {
  const extra = hexToBytes(extraData);
  const count = extra[VANITY];
  const start = VANITY + 1;
  if (!count || extra.length < start + count * ENTRY + SEAL) {
    throw new Error('not an epoch header: no validator set in extraData');
  }
  const out: Validator[] = [];
  for (let i = 0; i < count; i++) {
    const entry = extra.subarray(start + i * ENTRY, start + (i + 1) * ENTRY);
    const address = toHex(entry.subarray(0, 20));
    if (i > 0 && out[i - 1].address >= address) {
      throw new Error(`validator addresses are not strictly ascending at index ${i}`);
    }
    out.push({ address, pubkey: entry.subarray(20) });
  }
  return out;
}

/**
 * The turnLength byte after an epoch header's validator block (BEP-341): how
 * many blocks in a row each validator produces. Required, as the contract
 * requires it — every epoch header since Bohr carries one.
 */
export function parseTurnLength(extraData: string): number {
  const extra = hexToBytes(extraData);
  const at = VANITY + 1 + extra[VANITY] * ENTRY;
  if (!extra[VANITY] || extra.length < at + 1 + SEAL) {
    throw new Error('not an epoch header: no turnLength after the validator set');
  }
  if (!extra[at]) throw new Error('epoch header announces a zero turnLength');
  return extra[at];
}

/**
 * How many blocks after epoch block E the set E announces starts signing votes:
 * (m/2 + 1)·turnLength, with m and turnLength of the set still in force at E.
 * The same rule as `parlia::switch_delay` in the contract — see there for where
 * it comes from in `snapshot.go`.
 */
export function switchDelay(inForceCount: number, inForceTurnLength: number): number {
  return (Math.floor(inForceCount / 2) + 1) * inForceTurnLength;
}

/** An RLP quantity, minimally encoded. */
function rlpUint(v: number): Uint8Array {
  let hex = BigInt(v).toString(16);
  if (hex === '0') return new Uint8Array();
  if (hex.length % 2) hex = '0' + hex;
  return hexToBytes(hex);
}

/** The 32 bytes the validators signed. */
export function voteDigest(att: VoteAttestation): Uint8Array {
  return keccak_256(
    RLP.encode([
      rlpUint(att.sourceNumber),
      att.sourceHash,
      rlpUint(att.targetNumber),
      att.targetHash,
    ]),
  );
}

/** Which validators of `set` the bitset names. */
export function signersOf(att: VoteAttestation, set: Validator[]): Validator[] {
  if (set.length > 64) throw new Error('a 64-bit bitset cannot address this set');
  if (att.bitset >> BigInt(set.length)) throw new Error('bitset names validators outside the set');
  return set.filter((_, i) => (att.bitset >> BigInt(i)) & 1n);
}

/** Verify a vote against a set, exactly as the contract will. */
export function verifyAttestation(
  att: VoteAttestation,
  set: Validator[],
  dst: string = ETH_DST,
): { ok: boolean; signers: number; quorum: number } {
  const signers = signersOf(att, set);
  // BSC's own rule is ceil(2n/3), which for integers is 3*count >= 2*n.
  const quorum = Math.ceil((set.length * 2) / 3);
  const ok =
    signers.length >= quorum &&
    fastAggregateVerify(
      signers.map((v) => v.pubkey) as any,
      voteDigest(att),
      att.signature as any,
      dst,
    );
  return { ok, signers: signers.length, quorum };
}

/**
 * The `vote_proof` struct the contract takes.
 *
 * Every key of the set travels, not just the signers: the stored digest is over
 * the whole set and the bitset indexes into it. Points are converted to the
 * 96/192-byte affine little-endian form the BLS host functions consume, because
 * CDT has no decompression host function — the contract compresses them back and
 * compares, which is a byte shuffle where the other direction is a square root.
 */
export function voteProofArgs(att: VoteAttestation, set: Validator[]) {
  const keys = new Uint8Array(set.length * 96);
  set.forEach((v, i) => keys.set(encodeG1ToAntelope(v.pubkey), i * 96));
  return {
    bitset: att.bitset.toString(),
    sig: toHex(encodeG2ToAntelope(att.signature)).slice(2),
    source_number: att.sourceNumber,
    source_hash: toHex(att.sourceHash).slice(2),
    target_number: att.targetNumber,
    target_hash: toHex(att.targetHash).slice(2),
    keys: toHex(keys).slice(2),
  };
}

/** Only a vote whose target is its source's direct child finalizes anything. */
export function finalizes(att: VoteAttestation, header: EncodedHeader): boolean {
  return att.targetNumber === att.sourceNumber + 1 && toHex(att.sourceHash) === header.hash;
}
