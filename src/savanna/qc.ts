/**
 * The Quorum Certificate — the aggregate BLS signature that makes a block final,
 * and the thing an Ethereum verifier ultimately checks.
 *
 * It rides in **block** extension id 3, not the header extension (id 2) that
 * carries the policy diff. Layout from Spring:
 *
 *   FC_REFLECT(qc_t,     (block_num)(active_policy_sig)(pending_policy_sig))
 *   FC_REFLECT(qc_sig_t, (strong_votes)(weak_votes)(sig))
 *
 * with both vote fields `optional<fc::bitset>` and `sig` a length-prefixed
 * 192-byte aggregate G2 point.
 *
 * A QC signed by the active policy is the normal case. During a policy
 * transition it carries a *second* signature, `pending_policy_sig`, over the
 * same digest by the incoming policy — which is how a light client that only
 * knows one of the two can still follow the chain across the handover.
 *
 * Strong votes sign the block's finality digest directly. Weak votes sign a
 * separate weak digest, so a weak QC does not finalize and this bridge has no
 * use for one.
 */

import { Reader } from './policyDiff.ts';
import { rawG1ToCompressed, rawG2ToCompressed } from './encoding.ts';
import { fastAggregateVerify } from './aggregate.ts';
import { SAVANNA_DST } from './ciphersuite.ts';
import type { FinalizerPolicy } from './policyDiff.ts';

export const QC_EXTENSION_ID = 3;

export type Bitset = { numBits: number; bytes: Uint8Array };

export type QcSig = {
  strongVotes?: Bitset;
  weakVotes?: Bitset;
  /** Raw 192-byte affine little-endian G2, as packed. */
  sig: Uint8Array;
};

export type Qc = {
  blockNum: number;
  activePolicySig: QcSig;
  pendingPolicySig?: QcSig;
};

/**
 * `fc::bitset`: varuint32 bit count, then ceil(bits/8) bytes, bit 0 in the least
 * significant bit of byte 0. Unused trailing bits must be zero.
 */
function readBitset(r: Reader): Bitset {
  const numBits = r.varuint32();
  const bytes = r.bytes(Math.ceil(numBits / 8));
  return { numBits, bytes: Uint8Array.from(bytes) };
}

export function bitsetIndexes(b: Bitset): number[] {
  const out: number[] = [];
  for (let i = 0; i < b.numBits; i++) {
    if ((b.bytes[i >> 3] >> (i & 7)) & 1) out.push(i);
  }
  return out;
}

function readQcSig(r: Reader): QcSig {
  const strongVotes = r.optional(() => readBitset(r));
  const weakVotes = r.optional(() => readBitset(r));
  const sig = Uint8Array.from(r.varbytes());
  if (sig.length !== 192) throw new Error(`qc signature must be 192 bytes, got ${sig.length}`);
  return { strongVotes, weakVotes, sig };
}

export function parseQcExtension(payload: Uint8Array): Qc {
  const r = new Reader(payload);
  const blockNum = r.u32();
  const activePolicySig = readQcSig(r);
  const pendingPolicySig = r.optional(() => readQcSig(r));
  if (!r.exhausted) {
    throw new Error(`qc extension: ${r.remaining} trailing bytes — layout drifted`);
  }
  return { blockNum, activePolicySig, pendingPolicySig };
}

export type QcCheck = {
  ok: boolean;
  signers: number[];
  signedWeight: bigint;
  totalWeight: bigint;
  threshold: bigint;
  reason?: string;
};

/**
 * Verify one policy's half of a QC against the digest it claims to sign.
 *
 * Two independent things have to hold, and conflating them is how a verifier
 * ends up accepting a signature from one honest finalizer: the aggregate
 * signature must check out, **and** the signers' combined weight must reach the
 * policy's threshold. The signature alone says only that whoever signed did sign.
 */
export function verifyQcSig(
  policy: FinalizerPolicy,
  sig: QcSig,
  digest: Uint8Array,
): QcCheck {
  const totalWeight = policy.finalizers.reduce((a, f) => a + f.weight, 0n);

  if (!sig.strongVotes) {
    return {
      ok: false,
      signers: [],
      signedWeight: 0n,
      totalWeight,
      threshold: policy.threshold,
      reason: 'not a strong QC — weak votes sign a different digest and do not finalize',
    };
  }
  if (sig.weakVotes) {
    return {
      ok: false,
      signers: [],
      signedWeight: 0n,
      totalWeight,
      threshold: policy.threshold,
      reason: 'QC carries weak votes',
    };
  }
  if (sig.strongVotes.numBits !== policy.finalizers.length) {
    return {
      ok: false,
      signers: [],
      signedWeight: 0n,
      totalWeight,
      threshold: policy.threshold,
      reason: `bitset is ${sig.strongVotes.numBits} bits, policy has ${policy.finalizers.length} finalizers`,
    };
  }

  const signers = bitsetIndexes(sig.strongVotes);
  const signedWeight = signers.reduce((a, i) => a + policy.finalizers[i].weight, 0n);

  if (signedWeight < policy.threshold) {
    return {
      ok: false,
      signers,
      signedWeight,
      totalWeight,
      threshold: policy.threshold,
      reason: `signed weight ${signedWeight} below threshold ${policy.threshold}`,
    };
  }

  // Keys and signature are both packed affine little-endian; noble works in
  // compressed big-endian. See the converters at the bottom of this file.
  const pubkeys = signers.map((i) => rawG1ToCompressed(policy.finalizers[i].publicKey));
  const ok = fastAggregateVerify(pubkeys, digest, rawG2ToCompressed(sig.sig), SAVANNA_DST);

  return {
    ok,
    signers,
    signedWeight,
    totalWeight,
    threshold: policy.threshold,
    reason: ok ? undefined : 'aggregate signature did not verify',
  };
}

/**
 * Whether a certificate is strong, as `qc_t::is_strong` decides: both halves
 * strong votes only. A weak pending half makes the whole certificate weak.
 */
export function isStrongQc(qc: Qc): boolean {
  const strong = (s: QcSig) => !!s.strongVotes && !s.weakVotes;
  return strong(qc.activePolicySig) && (!qc.pendingPolicySig || strong(qc.pendingPolicySig));
}

export type QcVerdict = {
  ok: boolean;
  active: QcCheck;
  /** Present when a policy was pending and the certificate carried its half. */
  pending?: QcCheck;
  reason?: string;
};

/**
 * Verify a whole certificate the way Spring does: the active half, and while a
 * policy is pending, the pending half too, each against its own policy.
 *
 * `pending` is the policy pending at the certified block, or undefined when none
 * is. A certificate whose halves do not match that — a second half with nothing
 * pending, or none on a transition block — is not one the chain accepts.
 */
export function verifyQc(
  qc: Qc,
  active: FinalizerPolicy,
  pending: FinalizerPolicy | undefined,
  digest: Uint8Array,
): QcVerdict {
  const a = verifyQcSig(active, qc.activePolicySig, digest);
  if (!pending) {
    if (qc.pendingPolicySig) {
      return { ok: false, active: a, reason: 'a pending half, and no policy is pending' };
    }
    return { ok: a.ok, active: a, reason: a.reason };
  }
  if (!qc.pendingPolicySig) {
    return { ok: false, active: a, reason: 'a transition block, and no pending half' };
  }
  const p = verifyQcSig(pending, qc.pendingPolicySig, digest);
  const reason = !a.ok ? `active: ${a.reason}` : !p.ok ? `pending: ${p.reason}` : undefined;
  return { ok: a.ok && p.ok, active: a, pending: p, reason };
}

// --- point format helpers ------------------------------------------------------
//
// A raw packed point is affine little-endian x‖y; noble works in compressed
// big-endian. Round-tripping through the `PUB_BLS_…` string form would mean
// recomputing a ripemd160 checksum for no reason, so these go direct.


// The wire-format conversions live in `encoding.ts`, which owns every other
// Antelope-vs-noble byte-order difference. Re-exported here because a caller
// holding a certificate reaches for this module, not that one.
export { rawG1ToCompressed as compressedFromRaw, rawG2ToCompressed as compressedSigFromRaw };
