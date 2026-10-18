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

/** A Move call's argument as a wallet builds it: a shared object, or a pure value of a Move type. */
export type MoveArg = { object: string } | { type: string; value: string | number | boolean | (string | boolean)[] };
export type MoveCall = { target: string; typeArguments: string[]; arguments: MoveArg[] };

// The parameter types of `telos_client::submit_root_entry` after the client, and
// of `vault::release_entry` / `expire_entry` between the client and the clock.
const SUBMIT_ROOT_TYPES = [
  'u32', 'u32', 'u32', 'u32', 'vector<u8>', 'vector<u8>', 'u32', 'vector<u8>', 'u32', 'vector<u8>', 'u32', 'u32', 'vector<u8>',
  'vector<u8>', 'vector<u8>', 'vector<vector<u8>>', 'vector<u8>', 'vector<u8>', 'vector<u8>',
];
const PROOF_TYPES = [
  'vector<u8>', 'u64', 'vector<u8>', 'vector<vector<u8>>', 'vector<bool>',
  'u32', 'u32', 'u32', 'u32', 'u32', 'vector<u8>', 'vector<vector<u8>>', 'vector<bool>',
];
/** Sui's shared clock. */
export const SUI_CLOCK = '0x6';

function typed(types: string[], values: unknown[]): MoveArg[] {
  if (types.length !== values.length) throw new Error(`expected ${types.length} arguments, built ${values.length}`);
  return values.map((value, i) => ({ type: types[i], value: value as any }));
}

/** `submit_root_entry` on the client for a root half (an artifact's, or a handover's). */
export function submitRootCall(pkg: string, telosClient: string, s: SubmitRootArgs): MoveCall {
  return {
    target: `${pkg}::telos_client::submit_root_entry`,
    typeArguments: [],
    arguments: [{ object: telosClient }, ...typed(SUBMIT_ROOT_TYPES, submitRootArgs(s))],
  };
}

/** `install_policy` with the policy a handover's certificate committed to. */
export function installPolicyCall(pkg: string, telosClient: string, packed: string): MoveCall {
  return { target: `${pkg}::telos_client::install_policy`, typeArguments: [], arguments: [{ object: telosClient }, { type: 'vector<u8>', value: packed }] };
}

/** `release_entry<coin>` before the deadline, or `expire_entry` after it, for a frozen withdrawal. */
export function settleCall(kind: 'release' | 'expire', ids: { package: string; telosClient: string; vault: string; coinType: string }, artifact: any): MoveCall {
  return {
    target: `${ids.package}::vault::${kind}_entry`,
    typeArguments: kind === 'release' ? [ids.coinType] : [],
    arguments: [{ object: ids.vault }, { object: ids.telosClient }, ...typed(PROOF_TYPES, proofArgs(artifact)), { object: SUI_CLOCK }],
  };
}
