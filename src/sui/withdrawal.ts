/**
 * A frozen withdrawal artifact (`assembleWithdrawalArtifact`) as the arguments
 * of the Sui package's `telos_client::submit_root_entry` and
 * `vault::release_entry` / `vault::expire_entry`.
 *
 * The artifact is the one the EVM path freezes; only the encodings differ. Sui
 * takes the Antelope signature bytes (192, affine little-endian) where the EVM
 * takes EIP-2537's 256, a merkle branch as a list of sides rather than a bitmask,
 * and the `wdlog` data itself, which it authenticates and then decodes.
 */
import type { SubmitRootArgs } from '../savanna/withdrawalProof.ts';
import { concat, fromHex, hex, uleb } from './bcs.ts';

/** EIP-2537 G2 (four 64-byte big-endian limbs) back to Antelope's affine little-endian 192 bytes. */
export function eip2537G2ToRaw(eip: Uint8Array): Uint8Array {
  if (eip.length !== 256) throw new Error(`an EIP-2537 G2 point is 256 bytes, got ${eip.length}`);
  return concat(...[0, 1, 2, 3].map((c) => eip.subarray(c * 64 + 16, (c + 1) * 64).slice().reverse()));
}

const le64 = (v: bigint | string | number) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(v), true);
  return b;
};
const bytes32 = (s: string) => {
  const b = fromHex(s);
  if (b.length !== 32) throw new Error(`a Sui-shaped wdlog field is 32 bytes, got ${b.length}`);
  return b;
};

/** `wdlog`'s data in Sui's 32/32/32 shape, rebuilt from the decoded proof. */
export function wdlogData(vault: string, r: any): Uint8Array {
  const memo = fromHex(r.memo ?? '0x');
  return concat(
    le64(r.id), le64(r.domain),
    uleb(32), bytes32(vault), uleb(32), bytes32(r.token), uleb(32), bytes32(r.recipient),
    le64(r.amount), le64(r.deadline), le64(r.fee),
    uleb(memo.length), memo,
  );
}

/** A Solidity-style branch (siblings + bitmask, bit i set = node on the left) as Move's two lists. */
function branch(siblings: string[], path: string): { siblings: string[]; left: boolean[] } {
  return { siblings: siblings.map((s) => `0x${s.replace(/^0x/, '')}`), left: siblings.map((_, i) => ((BigInt(path) >> BigInt(i)) & 1n) === 1n) };
}

const h = (s: string) => `0x${s.replace(/^0x/, '')}`;

/**
 * `submit_root_entry` arguments after the client object, in order, from the
 * root half of a frozen artifact (`artifact.submitRoot`) or of a handover
 * (`buildHandover(...).args`): the same shape the EVM client takes.
 */
export function submitRootArgs(s: SubmitRootArgs): (string | number | string[])[] {
  const f = s.finality;
  const p = s.pending;
  return [
    f.majorVersion, f.minorVersion, f.activeGeneration, f.lastPendingGeneration,
    h(f.finalityMroot), h(f.lastPendingPolicyDigest), f.lastPendingPolicyStart,
    h(f.reversibleBlocksMroot), f.qcClaimBlockNum, h(f.qcClaimFinalityDigest), f.qcClaimTimestamp,
    f.timestamp, h(f.baseDigest),
    h(s.bits), `0x${hex(eip2537G2ToRaw(fromHex(s.signature)))}`,
    // keccak256 of each key of the signing policy, in its order: the EVM client's key identity, and the Sui client's.
    s.policyKeys.map(h),
    h(p.policy || '0x'), h(p.bits || '0x'),
    p.signature && p.signature !== '0x' ? `0x${hex(eip2537G2ToRaw(fromHex(p.signature)))}` : '0x',
  ];
}

/** `release_entry` / `expire_entry` arguments between the client and the clock, in order. */
export function proofArgs(artifact: any): (string | number | string[] | boolean[])[] {
  const r = artifact.release;
  const action = branch(r.actionSiblings, r.actionPath);
  const tree = branch(r.treeSiblings, r.treePath);
  return [
    `0x${hex(wdlogData(artifact.vault, r))}`, String(r.recvSequence), h(r.witness),
    action.siblings, action.left,
    r.majorVersion, r.minorVersion, r.blockNum, r.timestamp, r.parentTimestamp, h(r.finalityDigest),
    tree.siblings, tree.left,
  ];
}
