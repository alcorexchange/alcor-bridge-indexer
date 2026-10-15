/**
 * BLS12-381 ciphersuite constants for both sides of the bridge.
 *
 * Both Ethereum and Antelope/Savanna use the BLS12-381 "min-pubkey-size" scheme:
 *   - public keys live in G1 (48 bytes compressed)
 *   - signatures live in G2 (96 bytes compressed)
 * They differ in the Domain Separation Tag (DST) used for hash-to-curve and in
 * what bytes are signed. Getting the DST wrong means signatures silently fail to
 * verify, so each side keeps its tag explicit here.
 */

/**
 * Ethereum consensus-layer DST (IETF proof-of-possession ciphersuite).
 * Used by the sync committee when signing the beacon block signing root.
 * Source: eth2 BLS spec / consensus-specs.
 */
export const ETH_DST = 'BLS_SIG_BLS12381G2_XMD:SHA-256_SSWU_RO_POP_';

/**
 * Antelope / Savanna finalizer DST — the basic ("NUL") ciphersuite.
 * Finalizers sign the finality digest under THIS tag, NOT the POP one.
 * Source: AntelopeIO/bls12-381 src/signatures.cpp `CIPHERSUITE_ID`.
 */
export const SAVANNA_DST = 'BLS_SIG_BLS12381G2_XMD:SHA-256_SSWU_RO_NUL_';

/**
 * Antelope / Savanna proof-of-possession DST. Used only when verifying a
 * finalizer's PoP (which signs the finalizer's own 96-byte LE public key),
 * never for finality votes.
 * Source: AntelopeIO/bls12-381 src/signatures.cpp `POP_CIPHERSUITE_ID`.
 */
export const SAVANNA_POP_DST = 'BLS_POP_BLS12381G2_XMD:SHA-256_SSWU_RO_POP_';
