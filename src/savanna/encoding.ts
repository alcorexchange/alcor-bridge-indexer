/**
 * Decoding of Antelope/Vaulta BLS key & signature strings into the byte form
 * @noble/curves expects.
 *
 * Antelope does NOT use the standard zcash/ETH compressed encoding. A
 * `PUB_BLS_…` / `SIG_BLS_…` / `PVT_BLS_…` string is:
 *
 *     PREFIX + base64url( data ‖ ripemd160(data)[0:4] )
 *
 * where `data` is the AFFINE, NON-Montgomery, LITTLE-ENDIAN-per-coordinate point
 * (x before y; for G2, c0 before c1). To hand it to noble we reverse each 48-byte
 * coordinate to big-endian, rebuild the affine point, and re-serialize compressed.
 *
 * Source: AntelopeIO/spring libfc (bls_public_key.cpp / bls_signature.cpp /
 * bls_common.hpp) and AntelopeIO/bls12-381 g.cpp `toAffineBytesLE`.
 */
import { ripemd160 } from '@noble/hashes/legacy.js';
import { bls12_381 } from '@noble/curves/bls12-381';

const Fp2 = bls12_381.fields.Fp2;
const COORD = 48; // bytes per field coordinate

/** Interpret a little-endian byte slice as a bigint. */
function leToBigint(bytes: Uint8Array): bigint {
  let r = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) r = (r << 8n) | BigInt(bytes[i]);
  return r;
}

/**
 * Strip the `PREFIX_BLS_` prefix, base64url-decode, split off the trailing
 * 4-byte checksum and verify it (ripemd160 of the data, first 4 bytes).
 * Returns the raw `data` payload.
 */
function decodeChecksummed(str: string, prefix: string, dataLen: number): Uint8Array {
  if (!str.startsWith(prefix)) {
    throw new Error(`expected ${prefix}… , got ${str.slice(0, 12)}…`);
  }
  const bin = new Uint8Array(Buffer.from(str.slice(prefix.length), 'base64url'));
  if (bin.length !== dataLen + 4) {
    throw new Error(`bad length: ${bin.length}, expected ${dataLen + 4}`);
  }
  const data = bin.subarray(0, dataLen);
  const check = bin.subarray(dataLen);
  const expect = ripemd160(data).subarray(0, 4);
  for (let i = 0; i < 4; i++) {
    if (check[i] !== expect[i]) throw new Error('checksum mismatch');
  }
  return data;
}

/**
 * The raw 96-byte affine little-endian G1 payload -> compressed G1 (48 bytes).
 *
 * This is the form a finalizer policy carries its keys in, both in a header diff
 * and in `finality_data.pending_finalizer_policy`, so it is the entry point for
 * anything that reads a policy off the wire rather than out of a `PUB_BLS_…`
 * string.
 */
export function rawG1ToCompressed(raw: Uint8Array): Uint8Array {
  if (raw.length !== 96) throw new Error(`expected 96 raw bytes, got ${raw.length}`);
  const x = leToBigint(raw.subarray(0, COORD));
  const y = leToBigint(raw.subarray(COORD, 2 * COORD));
  return bls12_381.G1.Point.fromAffine({ x, y }).toBytes(true);
}

/**
 * The raw 192-byte affine little-endian G2 payload -> compressed G2 (96 bytes).
 *
 * The signature half of `rawG1ToCompressed`: this is how a quorum certificate
 * carries its aggregate signature on the wire.
 */
export function rawG2ToCompressed(raw: Uint8Array): Uint8Array {
  if (raw.length !== 192) throw new Error(`expected 192 raw bytes, got ${raw.length}`);
  const c = (i: number) => leToBigint(raw.subarray(i * COORD, (i + 1) * COORD));
  const x = Fp2.fromBigTuple([c(0), c(1)]);
  const y = Fp2.fromBigTuple([c(2), c(3)]);
  return bls12_381.G2.Point.fromAffine({ x, y }).toBytes(true);
}

/**
 * Decode a `PUB_BLS_…` string to a compressed G1 public key (48 bytes), ready to
 * pass to the aggregate verifier.
 */
export function decodeBlsPublicKey(str: string): Uint8Array {
  return rawG1ToCompressed(decodeBlsPublicKeyRaw(str));
}

/** Decode a `PUB_BLS_…` string to the raw 96 bytes a finalizer policy packs: x(48 LE) ‖ y(48 LE). */
export function decodeBlsPublicKeyRaw(str: string): Uint8Array {
  return decodeChecksummed(str, 'PUB_BLS_', 96);
}

/**
 * Decode a `SIG_BLS_…` string to a compressed G2 signature (96 bytes).
 * G2 layout is x.c0 ‖ x.c1 ‖ y.c0 ‖ y.c1, each a 48-byte LE coordinate.
 */
export function decodeBlsSignature(str: string): Uint8Array {
  const data = decodeChecksummed(str, 'SIG_BLS_', 192);
  const c = (i: number) => leToBigint(data.subarray(i * COORD, (i + 1) * COORD));
  const x = Fp2.fromBigTuple([c(0), c(1)]);
  const y = Fp2.fromBigTuple([c(2), c(3)]);
  return bls12_381.G2.Point.fromAffine({ x, y }).toBytes(true);
}

/**
 * Decode a `PVT_BLS_…` string to the raw 32-byte big-endian scalar.
 * On the wire it is a little-endian std::array<uint64_t,4>, so we reverse it.
 */
export function decodeBlsPrivateKey(str: string): Uint8Array {
  const data = decodeChecksummed(str, 'PVT_BLS_', 32);
  return data.slice().reverse();
}

// --- encoders: noble point -> Antelope raw affine little-endian bytes ----------
// Inverse of the decoders above; produce exactly what the `bls_*` host functions
// (and our bridgebls contract) consume: G1 = 96 bytes, G2 = 192 bytes, each
// coordinate a 48-byte little-endian field element.

/** Serialize a bigint to a little-endian byte array of fixed length. */
function bigintToLE(v: bigint, len: number): Uint8Array {
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/** Compressed G1 pubkey bytes -> Antelope 96-byte affine LE (x ‖ y). */
export function encodeG1ToAntelope(compressed: Uint8Array): Uint8Array {
  const { x, y } = bls12_381.G1.Point.fromBytes(compressed).toAffine();
  const out = new Uint8Array(96);
  out.set(bigintToLE(x, COORD), 0);
  out.set(bigintToLE(y, COORD), COORD);
  return out;
}

/** Compressed G2 signature bytes -> Antelope 192-byte affine LE (x.c0 ‖ x.c1 ‖ y.c0 ‖ y.c1). */
export function encodeG2ToAntelope(compressed: Uint8Array): Uint8Array {
  const { x, y } = bls12_381.G2.Point.fromBytes(compressed).toAffine();
  const out = new Uint8Array(192);
  out.set(bigintToLE(x.c0, COORD), 0 * COORD);
  out.set(bigintToLE(x.c1, COORD), 1 * COORD);
  out.set(bigintToLE(y.c0, COORD), 2 * COORD);
  out.set(bigintToLE(y.c1, COORD), 3 * COORD);
  return out;
}

// --- encoders: noble point -> EIP-2537 (Ethereum BLS precompile) format --------
// EIP-2537 encodes each field element as 64 bytes = 16 zero bytes + 48-byte
// big-endian. G1 = x‖y (128 bytes), G2 = x.c0‖x.c1‖y.c0‖y.c1 (256 bytes).

/** Serialize a bigint big-endian into 48 bytes, left-padded to 64 (EIP-2537 field element). */
function bigintToBE64(v: bigint): Uint8Array {
  const out = new Uint8Array(64);
  for (let i = 63; i >= 16; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/** Compressed G1 pubkey -> EIP-2537 128-byte point (x ‖ y). */
export function encodeG1ToEip2537(compressed: Uint8Array): Uint8Array {
  const { x, y } = bls12_381.G1.Point.fromBytes(compressed).toAffine();
  const out = new Uint8Array(128);
  out.set(bigintToBE64(x), 0);
  out.set(bigintToBE64(y), 64);
  return out;
}

/**
 * A policy's raw 96-byte G1 key -> the 128 bytes `setPolicy` stores.
 *
 * Both ends of this are affine and uncompressed and yet nothing about them
 * matches: Antelope writes each coordinate little-endian and unpadded, EIP-2537
 * wants big-endian left-padded to 64. Feeding one to the other produces a point
 * that is simply a different point, with no error anywhere — so the conversion
 * exists as a named step rather than as two lines at a call site.
 */
export function rawG1ToEip2537(raw: Uint8Array): Uint8Array {
  return encodeG1ToEip2537(rawG1ToCompressed(raw));
}

/**
 * The 128-byte EIP-2537 G1 key back to Antelope's raw 96 bytes.
 *
 * The inverse of `rawG1ToEip2537`, and it exists because a stored policy artifact
 * keeps whichever form it was written in while `setPolicy` insists on the
 * Antelope one — it rejects 128 bytes with "pubkey must be 96 raw bytes", which
 * is the good outcome. Feeding the other form silently would install points that
 * are simply different points.
 *
 * Pure byte shuffling, no curve arithmetic: EIP-2537 pads each coordinate to 64
 * bytes big-endian, Antelope writes 48 bytes little-endian, so each coordinate is
 * the other reversed.
 */
export function eip2537ToRawG1(eip: Uint8Array): Uint8Array {
  if (eip.length !== 128) throw new Error(`EIP-2537 G1 is 128 bytes, got ${eip.length}`);
  const out = new Uint8Array(96);
  for (let half = 0; half < 2; half++) {
    const be = eip.subarray(half * 64 + 16, half * 64 + 64); // drop the 16-byte pad
    for (let i = 0; i < 48; i++) out[half * 48 + i] = be[47 - i];
  }
  return out;
}

/**
 * A certificate's raw 192-byte G2 signature -> the 256 bytes the precompile takes.
 *
 * EIP-2537 has no compressed form. A compressed G2 point is 96 bytes and looks
 * like a signature, so passing one along reaches the contract and fails there on
 * a length check rather than anywhere near the code that chose it.
 */
export function rawG2ToEip2537(raw: Uint8Array): Uint8Array {
  return encodeG2ToEip2537(rawG2ToCompressed(raw));
}

/** Compressed G2 signature -> EIP-2537 256-byte point (x.c0 ‖ x.c1 ‖ y.c0 ‖ y.c1). */
export function encodeG2ToEip2537(compressed: Uint8Array): Uint8Array {
  const { x, y } = bls12_381.G2.Point.fromBytes(compressed).toAffine();
  const out = new Uint8Array(256);
  out.set(bigintToBE64(x.c0), 0);
  out.set(bigintToBE64(x.c1), 64);
  out.set(bigintToBE64(y.c0), 128);
  out.set(bigintToBE64(y.c1), 192);
  return out;
}

/**
 * Encode the raw 96-byte affine little-endian G1 payload as a `PUB_BLS_…`
 * string — the inverse of `decodeChecksummed`.
 *
 * Needed because a finalizer policy diff carries public keys as those raw 96
 * bytes, while every human-readable source (the node's own decode, bp.json,
 * `get_producer_schedule`) shows the string form. Without this, checking a
 * parsed policy against the chain means comparing hex to base64url by eye.
 */
export function encodeBlsPublicKeyRaw(raw: Uint8Array): string {
  if (raw.length !== 96) throw new Error(`expected 96 raw bytes, got ${raw.length}`);
  const check = ripemd160(raw).subarray(0, 4);
  const out = new Uint8Array(100);
  out.set(raw, 0);
  out.set(check, 96);
  return 'PUB_BLS_' + Buffer.from(out).toString('base64url');
}
