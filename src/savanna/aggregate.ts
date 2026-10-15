/**
 * Thin, shared wrapper over @noble/curves BLS12-381 "long signatures" variant
 * (G1 pubkeys, G2 signatures) — the variant both Ethereum and Savanna use.
 *
 * The core operation for both light clients is the same: a committee all signs
 * the SAME message, so we can sum their public keys into one aggregate key and
 * the signatures into one aggregate signature, then settle it with a single
 * pairing check (this is eth2's "FastAggregateVerify").
 */
import { bls12_381 } from '@noble/curves/bls12-381';

const bls = bls12_381.longSignatures;

export type Hex = string | Uint8Array;

/** Sum a set of G1 public keys into a single aggregate key (compressed bytes). */
export function aggregatePublicKeys(pubkeys: Hex[]): Uint8Array {
  return bls.aggregatePublicKeys(pubkeys as Uint8Array[]).toBytes(true);
}

/** Sum a set of G2 signatures into a single aggregate signature (compressed bytes). */
export function aggregateSignatures(signatures: Hex[]): Uint8Array {
  return bls.aggregateSignatures(signatures as Uint8Array[]).toBytes(true);
}

/**
 * FastAggregateVerify: verify one aggregate signature over a single message that
 * was signed by every key in `pubkeys`, under the given domain separation tag.
 *
 * @param pubkeys    the committee public keys that (claim to have) signed
 * @param message    the exact bytes that were hashed-to-curve and signed
 * @param signature  the aggregate G2 signature
 * @param dst        the ciphersuite DST for this chain (ETH_DST / SAVANNA_DST)
 */
export function fastAggregateVerify(
  pubkeys: Hex[],
  message: Uint8Array,
  signature: Hex,
  dst: string,
): boolean {
  const aggPk = bls.aggregatePublicKeys(pubkeys as Uint8Array[]);
  const msgPoint = bls.hash(message, dst);
  return bls.verify(signature as Uint8Array, msgPoint, aggPk);
}

/** Verify a single (non-aggregate) signature — handy for fixtures and debugging. */
export function verify(
  pubkey: Hex,
  message: Uint8Array,
  signature: Hex,
  dst: string,
): boolean {
  const msgPoint = bls.hash(message, dst);
  return bls.verify(signature as Uint8Array, msgPoint, pubkey as Uint8Array);
}

/** Derive a compressed G1 public key from a 32-byte secret (test helper). */
export function getPublicKey(secretKey: Hex): Uint8Array {
  return bls.getPublicKey(secretKey as Uint8Array).toBytes(true);
}

/** Sign `message` (hashed-to-curve under `dst`) with `secretKey` (test helper). */
export function sign(secretKey: Hex, message: Uint8Array, dst: string): Uint8Array {
  const msgPoint = bls.hash(message, dst);
  return bls.sign(msgPoint, secretKey as Uint8Array).toBytes(true);
}
