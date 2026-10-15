/**
 * Ethereum side of the bridge (as seen FROM Savanna):
 * verify that Ethereum's sync committee BLS-signed a given beacon block header.
 *
 * This is the Altair light-client check. The sync committee (512 validators) all
 * sign the SAME `signing_root`, so verification is a FastAggregateVerify over the
 * participating subset of the committee.
 *
 * Level-0 scope: just the signature math + signing-root derivation. Committee
 * rotation (period transitions) and the merkle proofs that link the committee to
 * a finalized state are deliberately out of scope here.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { ETH_DST } from '../savanna/ciphersuite.ts';
import { fastAggregateVerify, type Hex } from '../savanna/aggregate.ts';

/**
 * signing_root = hash_tree_root(SigningData{ object_root, domain }).
 * SigningData is a container of two 32-byte leaves, so its merkleization is just
 * sha256(object_root ++ domain).
 *
 * @param blockHeaderRoot  hash_tree_root of the BeaconBlockHeader (32 bytes)
 * @param domain           the 32-byte signature domain (DOMAIN_SYNC_COMMITTEE,
 *                         mixed with fork version + genesis validators root)
 */
export function computeSigningRoot(blockHeaderRoot: Uint8Array, domain: Uint8Array): Uint8Array {
  if (blockHeaderRoot.length !== 32) throw new Error('blockHeaderRoot must be 32 bytes');
  if (domain.length !== 32) throw new Error('domain must be 32 bytes');
  const buf = new Uint8Array(64);
  buf.set(blockHeaderRoot, 0);
  buf.set(domain, 32);
  return sha256(buf);
}

/**
 * Verify a sync committee aggregate signature over a beacon block header.
 *
 * @param participantPubkeys  the committee members whose bit was set in the
 *                            sync aggregate (the actual signers)
 * @param signingRoot         output of computeSigningRoot()
 * @param aggregateSignature  the 96-byte G2 sync committee signature
 */
export function verifySyncCommittee(
  participantPubkeys: Hex[],
  signingRoot: Uint8Array,
  aggregateSignature: Hex,
): boolean {
  return fastAggregateVerify(participantPubkeys, signingRoot, aggregateSignature, ETH_DST);
}

/** DOMAIN_SYNC_COMMITTEE — the domain type sync committee members sign under. */
export const DOMAIN_SYNC_COMMITTEE = Uint8Array.of(0x07, 0x00, 0x00, 0x00);

/**
 * fork_data_root = hash_tree_root(ForkData{ current_version, genesis_validators_root }).
 * ForkData is a two-leaf container; Version is 4 bytes right-padded to a 32-byte
 * leaf, so the merkleization is just sha256(pad32(version) ++ genesis_validators_root).
 */
export function computeForkDataRoot(forkVersion: Uint8Array, genesisValidatorsRoot: Uint8Array): Uint8Array {
  if (forkVersion.length !== 4) throw new Error('forkVersion must be 4 bytes');
  if (genesisValidatorsRoot.length !== 32) throw new Error('genesisValidatorsRoot must be 32 bytes');
  const buf = new Uint8Array(64);
  buf.set(forkVersion, 0);
  buf.set(genesisValidatorsRoot, 32);
  return sha256(buf);
}

/**
 * compute_domain: domain_type ++ fork_data_root[0:28].
 *
 * The fork version must be the one active at the *signature* slot, not at the
 * slot of the header being signed — across a fork boundary those differ and the
 * signature silently fails to verify.
 */
export function computeDomain(
  domainType: Uint8Array,
  forkVersion: Uint8Array,
  genesisValidatorsRoot: Uint8Array,
): Uint8Array {
  const domain = new Uint8Array(32);
  domain.set(domainType, 0);
  domain.set(computeForkDataRoot(forkVersion, genesisValidatorsRoot).subarray(0, 28), 4);
  return domain;
}
