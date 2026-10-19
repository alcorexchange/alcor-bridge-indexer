/**
 * A frozen withdrawal artifact (`assembleWithdrawalArtifact`) as the JSON
 * arguments of the NEAR vault's `submit_root` and `release` / `expire`
 * (contracts/near).
 *
 * The artifact is the one the EVM path freezes; NEAR takes the same pieces as
 * the Sui package does — the Antelope signature bytes (192, affine
 * little-endian), a branch as a list of sides, the `wdlog` data itself — every
 * byte string in base64, as near-sdk's `Base64VecU8`.
 */
import type { SubmitRootArgs } from '../savanna/withdrawalProof.ts';
import { fromHex } from '../sui/bcs.ts';
import { eip2537G2ToRaw, wdlogData } from '../sui/withdrawal.ts';

const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');
const b64hex = (s: string) => b64(fromHex(s));

/** A Solidity-style branch (siblings + bitmask, bit i set = node on the left) as two lists. */
function branch(siblings: string[], path: string): { siblings: string[]; left: boolean[] } {
  return { siblings: siblings.map(b64hex), left: siblings.map((_, i) => ((BigInt(path) >> BigInt(i)) & 1n) === 1n) };
}

/** `submit_root`'s arguments, from a frozen artifact's root half or a handover. */
export function submitRootArgs(s: SubmitRootArgs) {
  const f = s.finality;
  const p = s.pending;
  const transition = !!p.policy && p.policy !== '0x';
  return {
    finality: {
      major_version: f.majorVersion,
      minor_version: f.minorVersion,
      active_generation: f.activeGeneration,
      last_pending_generation: f.lastPendingGeneration,
      finality_mroot: b64hex(f.finalityMroot),
      last_pending_policy_digest: b64hex(f.lastPendingPolicyDigest),
      last_pending_policy_start: f.lastPendingPolicyStart,
      reversible_blocks_mroot: b64hex(f.reversibleBlocksMroot),
      qc_claim_block_num: f.qcClaimBlockNum,
      qc_claim_finality_digest: b64hex(f.qcClaimFinalityDigest),
      qc_claim_timestamp: f.qcClaimTimestamp,
      timestamp: f.timestamp,
      base_digest: b64hex(f.baseDigest),
    },
    bits: b64hex(s.bits),
    signature: b64(eip2537G2ToRaw(fromHex(s.signature))),
    // keccak256 of each key of the signing policy, in its order: the EVM client's key identity, and this one's.
    policy_keys: s.policyKeys.map(b64hex),
    pending_policy: transition ? b64hex(p.policy) : null,
    pending_bits: transition ? b64hex(p.bits) : null,
    pending_signature: transition ? b64(eip2537G2ToRaw(fromHex(p.signature))) : null,
  };
}

/** The `proof` argument of `release` and `expire`. */
export function proofArg(artifact: any) {
  const r = artifact.release;
  const action = branch(r.actionSiblings, r.actionPath);
  const tree = branch(r.treeSiblings, r.treePath);
  return {
    data: b64(wdlogData(artifact.vault, r)),
    recv_sequence: String(r.recvSequence),
    witness: b64hex(r.witness),
    action_siblings: action.siblings,
    action_left: action.left,
    major_version: r.majorVersion,
    minor_version: r.minorVersion,
    block_num: r.blockNum,
    timestamp: r.timestamp,
    parent_timestamp: r.parentTimestamp,
    finality_digest: b64hex(r.finalityDigest),
    tree_siblings: tree.siblings,
    tree_left: tree.left,
  };
}

/**
 * One function call a NEAR wallet sends to the vault, as near-api-js and the
 * wallet selector take it: `deposit` in yoctoNEAR and `gas` in gas units, both
 * decimal strings. Storage is paid from the deposit and the rest refunded, so
 * 0.01 NEAR covers any one call.
 */
export type NearCall = { contract: string; method: string; args: Record<string, unknown>; deposit: string; gas: string };

/** 0.01 NEAR: more than any single call's storage; the vault refunds the rest. */
export const CALL_DEPOSIT = '10000000000000000000000';
/**
 * 100 Tgas. What is not burnt is refunded, but the sender must hold the whole
 * amount at the network's highest price first: 300 Tgas asked for ~0.31 NEAR.
 * The heaviest call measured is `set_policy` at 30 Tgas; a release with its
 * callback and fee transfer reserves 50.
 */
export const CALL_GAS = '100000000000000';

export const nearCallOf = (contract: string, method: string, args: Record<string, unknown>): NearCall =>
  ({ contract, method, args, deposit: CALL_DEPOSIT, gas: CALL_GAS });

/** A signer key the vault does not know, with its proof of possession (`regfinkey`). */
export type KeyToLearn = { raw: Uint8Array; pop: Uint8Array };

/**
 * The calls that settle a frozen withdrawal on NEAR, in order: `register_key`
 * for each signer the vault's client does not know, `submit_root` unless the
 * root is already trusted, then `release` before the deadline or `expire` after
 * it. `recipient` is the account id whose sha256 the withdrawal names; when only
 * the hash is known it is null, for the wallet to fill with its own account.
 */
export function settleCalls(o: {
  vault: string;
  artifact: any;
  submitRoot: SubmitRootArgs;
  learn: KeyToLearn[];
  trusted: boolean;
  token: string;
  recipient: string | null;
  pastDeadline: boolean;
}): NearCall[] {
  const calls = o.learn.map((k) => nearCallOf(o.vault, 'register_key', { key: b64(k.raw), pop: b64(k.pop) }));
  if (!o.trusted) calls.push(nearCallOf(o.vault, 'submit_root', submitRootArgs(o.submitRoot)));
  const proof = proofArg(o.artifact);
  calls.push(o.pastDeadline
    ? nearCallOf(o.vault, 'expire', { proof })
    : nearCallOf(o.vault, 'release', { proof, token: o.token, recipient: o.recipient }));
  return calls;
}

/** The two calls that walk the vault's client over one policy handover: its root, then its policy. */
export function handoverCalls(vault: string, s: SubmitRootArgs): NearCall[] {
  return [
    nearCallOf(vault, 'submit_root', submitRootArgs(s)),
    nearCallOf(vault, 'install_policy', { packed: b64hex(s.pending.policy) }),
  ];
}
