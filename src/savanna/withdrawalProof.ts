/**
 * Assembling the two Ethereum-side arguments that settle a withdrawal.
 *
 * `TelosLightClient.submitRoot` takes a block's finality digest components and a
 * quorum certificate; it costs a BLS pairing and is paid once per root.
 * `AlcorWithdrawals.release` then folds one action into that root, which is
 * cheap. Everything here is the off-chain half of those two.
 *
 * The chain of custody being built, bottom up:
 *
 *   wdlog payload  ──digest──▶  action receipt digest
 *                                     │ branch over the block's receipts
 *                                     ▼
 *                               action_mroot
 *                                     │ one of seven fields of the finality leaf
 *                                     ▼
 *                               finality leaf
 *                                     │ branch over the finality tree
 *                                     ▼
 *                               finality_mroot   ← signed by the finalizers
 *
 * Every fold is checked here before anything is submitted. A proof that leaves
 * this module is one the contracts should accept; if they then reject it, the
 * disagreement is on-chain, which is a far shorter search than "somewhere in the
 * proof".
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { keccak_256 } from '@noble/hashes/sha3.js';

import { treeProof, foldProof, type Step, type IncrementalTree } from '../proof/merkle.ts';
import { timestampToSlot, type SlotEpoch } from '../proof/pack.ts';
import { bare, fromHex, hex0x, toHex, toHex0x } from '../proof/hex.ts';
import {
  actionDigestSavanna,
  receiptsInExecutionOrder,
  savannaWitness,
  type ActionTrace,
} from './traces.ts';
import { finalityLeafBytes } from './tree.ts';
import type { Qc, QcSig } from './qc.ts';
import { rawG2ToEip2537 } from './encoding.ts';
import { packFinalizerPolicy, type FinalizerPolicy } from './policyDiff.ts';
import type { FinalityData } from './ship.ts';

/** `wdlog(id, domain, vault, token, recipient, amount, deadline, fee, memo)`, as packed on chain. */
export type WdlogPayload = {
  id: bigint;
  domain: bigint;
  /** The vault that pays it. Not a proof field: the verifier puts its own in. */
  vault: string;
  token: string;
  recipient: string;
  /** Canonical units burned, the fee included. */
  amount: bigint;
  deadline: bigint;
  /** Canonical units of `amount` paid to whoever delivers the withdrawal. */
  fee: bigint;
  /** Bytes for the recipient, `0x`-prefixed hex; `0x` for a plain withdrawal. */
  memo: string;
};

/**
 * The address width of a `wdlog` proved by a frozen Savanna artifact: 20 bytes
 * for an EVM chain, 32 for Sui. Null for an Antelope chain, whose relayer
 * proves its own (vault 8, token 16, recipient 8).
 */
export function frozenAddressWidth(d: Uint8Array): 20 | 32 | null {
  if (d.length > 16 && d[16] === 20) return 20;
  if (d.length > 16 && d[16] === 32) return 32;
  return null;
}

/**
 * Decode a `wdlog` action's data.
 *
 * Positional, because every field is fixed width except the three addresses
 * and the memo. The addresses carry the single-byte LEB128 length `fc::raw::pack`
 * writes — `0x14` for EVM's 20 bytes, `0x20` for Sui's 32, the same for all
 * three; the memo carries its own LEB128 length and ends the payload exactly.
 * The Solidity and Move verifiers rebuild this layout, so they must change
 * together with it — which is why the lengths are asserted rather than skipped.
 */
export function decodeWdlog(dataHex: string): WdlogPayload {
  const d = fromHex(dataHex);
  const w = frozenAddressWidth(d);
  if (w === null) throw new Error('wdlog: expected a 20- or 32-byte length prefix before each address');
  const a = 16; // vault prefix
  const b = a + 1 + w; // token prefix
  const c = b + 1 + w; // recipient prefix
  const tail = c + 1 + w;
  const fixed = tail + 8 + 8 + 8;
  if (d.length <= fixed) {
    throw new Error(`wdlog data is ${d.length} bytes, expected more than ${fixed}`);
  }
  if (d[b] !== w || d[c] !== w) {
    throw new Error(`wdlog: expected a ${w}-byte length prefix before each address`);
  }
  const view = new DataView(d.buffer, d.byteOffset, d.byteLength);
  return {
    id: view.getBigUint64(0, true),
    domain: view.getBigUint64(8, true),
    vault: toHex0x(d.subarray(a + 1, b)),
    token: toHex0x(d.subarray(b + 1, c)),
    recipient: toHex0x(d.subarray(c + 1, tail)),
    amount: view.getBigUint64(tail, true),
    deadline: view.getBigUint64(tail + 8, true),
    fee: view.getBigUint64(tail + 16, true),
    memo: toHex0x(memoAt(d, fixed)),
  };
}

/** One `wdlog` of a block, as `blockWdlogs` lists it. */
export type BlockWdlog = {
  /** Which `wdlog` of the block it is, counted in execution order: what a proof is built for. */
  ordinal: number;
  /** Its position among the block's receipts, which is its leaf in `action_mroot`. */
  index: number;
  trxId: string;
  /** The packed payload, hex. */
  data: string;
  id: bigint;
  domain: bigint;
  /**
   * Proved by a frozen Savanna artifact: bound for an EVM chain or Sui, whose
   * addresses carry the 20- or 32-byte length prefix `decodeWdlog` asserts. One
   * bound for an Antelope chain packs names there instead, is proved by that
   * chain's relayer, and has no artifact to freeze.
   */
  frozen: boolean;
};

/**
 * Every `wdlog` the bridge emitted in a block, in execution order.
 *
 * The one predicate for which action is the n-th withdrawal of a block. The
 * ordinal chooses WHICH withdrawal a proof is built for, so the follower that
 * picks one and `buildReleaseProof` that proves it must count the same way: two
 * filters that agree today and diverge later would prove the wrong withdrawal
 * with a fold that succeeds.
 */
export function blockWdlogs(traces: ActionTrace[], bridgeAccount: string): BlockWdlog[] {
  return receiptsInExecutionOrder(traces)
    .map((t, index) => ({ t, index }))
    .filter(({ t }) => t.account === bridgeAccount && t.name === 'wdlog')
    .map(({ t, index }, ordinal) => {
      const d = fromHex(t.data);
      const view = new DataView(d.buffer, d.byteOffset, d.byteLength);
      return {
        ordinal,
        index,
        trxId: t.trxId,
        data: t.data,
        id: view.getBigUint64(0, true),
        domain: view.getBigUint64(8, true),
        frozen: frozenAddressWidth(d) !== null,
      };
    });
}

/** The LEB128-prefixed bytes starting at `offset`, which must end the payload. */
function memoAt(d: Uint8Array, offset: number): Uint8Array {
  let length = 0;
  let shift = 0;
  let i = offset;
  for (;;) {
    if (i >= d.length) throw new Error('wdlog: memo length runs past the payload');
    const b = d[i++];
    length |= (b & 0x7f) << shift;
    if (!(b & 0x80)) break;
    shift += 7;
    if (shift > 28) throw new Error('wdlog: memo length is not a varuint32');
  }
  if (i + length !== d.length) {
    throw new Error(`wdlog: memo of ${length} bytes does not end the payload`);
  }
  return d.subarray(i, i + length);
}

/** Arguments for `TelosLightClient.submitRoot`. */
export type SubmitRootArgs = {
  finality: {
    majorVersion: number;
    minorVersion: number;
    activeGeneration: number;
    lastPendingGeneration: number;
    finalityMroot: string;
    lastPendingPolicyDigest: string;
    lastPendingPolicyStart: number;
    reversibleBlocksMroot: string;
    qcClaimBlockNum: number;
    qcClaimFinalityDigest: string;
    qcClaimTimestamp: number;
    timestamp: number;
    baseDigest: string;
  };
  /** Participation bitset, LSB-first per byte, as the contract walks it. */
  bits: string;
  /**
   * The chain's active finalizer policy at this block, in its own order, each
   * entry `keccak(antelope key)`.
   *
   * Supplied rather than read from the contract because the two need not match:
   * the light client's policy may lag the chain, and the certificate still has
   * to be checked against whoever actually signed it. Every key named must
   * already be registered on chain, and only ones holding a seat count toward
   * the threshold — so this list says where to look, never who is trusted.
   */
  policyKeys: string[];
  /**
   * Aggregate G2 signature, 256 bytes, EIP-2537 affine.
   *
   * Not compressed: the precompiles have no compressed form, and a 96-byte
   * compressed point is a perfectly valid signature that the contract rejects on
   * a length check far from whatever chose it.
   */
  signature: string;
  /**
   * The pending policy's half of the certificate — `TelosLightClient.PendingQc`.
   *
   * Only a transition block has one: while a policy is pending, Spring counts a
   * block final only if both policies' quorums signed it, and the contract
   * checks both. Everywhere else all three are `0x`.
   */
  pending: {
    /** The pending policy, packed; the digest commits to its sha256. */
    policy: string;
    /** Its strong votes, indexing the pending policy's own order. */
    bits: string;
    signature: string;
  };
};

/**
 * `submitRoot` as `cast` names it. The struct's field order is checked against
 * the Solidity by `tools/struct-alignment.py`.
 */
export const SUBMIT_ROOT_SIG =
  'submitRoot((uint32,uint32,uint32,uint32,bytes32,bytes32,uint32,bytes32,uint32,bytes32,uint32,uint32,bytes32),bytes,bytes,bytes32[],(bytes,bytes,bytes))';

const tuple = (...parts: (string | number)[]) => `(${parts.join(',')})`;

/** `submitRoot`'s arguments as the strings `cast` takes, in order. */
export function submitRootCastArgs(a: SubmitRootArgs): string[] {
  const f = a.finality;
  const finalityTuple = tuple(
    f.majorVersion,
    f.minorVersion,
    f.activeGeneration,
    f.lastPendingGeneration,
    f.finalityMroot,
    f.lastPendingPolicyDigest,
    f.lastPendingPolicyStart,
    f.reversibleBlocksMroot,
    f.qcClaimBlockNum,
    f.qcClaimFinalityDigest,
    f.qcClaimTimestamp,
    f.timestamp,
    f.baseDigest,
  );
  const q = a.pending;
  const pendingTuple = tuple(q.policy, q.bits, q.signature);
  return [finalityTuple, a.bits, a.signature, `[${a.policyKeys.join(',')}]`, pendingTuple];
}

/**
 * A frozen set of `submitRoot` arguments, as the contract takes them today.
 *
 * Artifacts frozen before `submitRoot` took a pending half have no `pending`.
 * They stay the only copy of their proof, so they are read rather than refused:
 * off a transition block that half is empty anyway. On a transition block such
 * an artifact is missing a signature the contract now demands, and that is said
 * here instead of by a revert on chain.
 */
export function frozenSubmitRoot(
  a: Omit<SubmitRootArgs, 'pending'> & { pending?: SubmitRootArgs['pending'] },
): SubmitRootArgs {
  if (a.pending) return a as SubmitRootArgs;
  if (a.finality.activeGeneration !== a.finality.lastPendingGeneration) {
    throw new Error(
      `root ${a.finality.finalityMroot} is from a transition block and the artifact was frozen ` +
        'without the pending half of its certificate; refreeze it',
    );
  }
  return { ...a, pending: { policy: '0x', bits: '0x', signature: '0x' } };
}

/** One half of a certificate as the contract takes it: strong votes only. */
function strongHalf(sig: QcSig, which: string): { bits: string; signature: string } {
  if (!sig.strongVotes || sig.weakVotes) {
    throw new Error(`only a strong quorum certificate finalizes a root (${which} half)`);
  }
  return { bits: toHex0x(sig.strongVotes.bytes), signature: toHex0x(rawG2ToEip2537(sig.sig)) };
}

/**
 * Build `submitRoot` arguments for the block whose root a withdrawal settles
 * against.
 *
 * `carrier` is the block holding the quorum certificate; the root being accepted
 * belongs to the block that certificate claims, which is usually the one before
 * it. That indirection is why a proof fetched the instant a withdrawal lands may
 * still be waiting: the QC signing a root travels a block behind the root.
 */
export function submitRootArgs(
  chain: SlotEpoch,
  target: { finalityData: FinalityData; finalityMroot: string; timestamp: string | number },
  lastPending: { digest: string; startSlot: number },
  qc: Qc,
  /** The policy actually signing at this block — the one the bitset indexes. */
  activePolicy: FinalizerPolicy,
  /**
   * The policy pending at this block. Required on a transition block — where
   * the active and last-pending generations differ — and ignored elsewhere.
   */
  pendingPolicy?: FinalizerPolicy,
): SubmitRootArgs {
  const fd = target.finalityData;
  const active = strongHalf(qc.activePolicySig, 'active');
  const pending = pendingHalf(fd, qc, pendingPolicy);
  return {
    finality: {
      majorVersion: fd.major_version,
      minorVersion: fd.minor_version,
      activeGeneration: fd.active_finalizer_policy_generation,
      lastPendingGeneration: fd.last_pending_finalizer_policy_generation,
      finalityMroot: hex0x(target.finalityMroot),
      lastPendingPolicyDigest: hex0x(lastPending.digest),
      lastPendingPolicyStart: lastPending.startSlot,
      reversibleBlocksMroot: hex0x(fd.reversible_blocks_mroot),
      qcClaimBlockNum: fd.latest_qc_claim_block_num,
      qcClaimFinalityDigest: hex0x(fd.latest_qc_claim_finality_digest),
      qcClaimTimestamp: fd.latest_qc_claim_timestamp,
      timestamp:
        typeof target.timestamp === 'number'
          ? target.timestamp
          : timestampToSlot(chain, target.timestamp),
      baseDigest: hex0x(fd.base_digest),
    },
    bits: active.bits,
    policyKeys: activePolicy.finalizers.map((f) => toHex0x(keccak_256(f.publicKey))),
    signature: active.signature,
    pending,
  };
}

/**
 * The pending half, or three empty values off a transition.
 *
 * Checked against what the block itself says rather than trusted from the
 * caller: a policy of the wrong generation, or a certificate without the second
 * half, would only fail later on chain.
 */
function pendingHalf(fd: FinalityData, qc: Qc, policy?: FinalizerPolicy): SubmitRootArgs['pending'] {
  const transition = fd.active_finalizer_policy_generation !== fd.last_pending_finalizer_policy_generation;
  if (!transition) {
    if (qc.pendingPolicySig) throw new Error('a certificate outside a transition carries a pending half');
    return { policy: '0x', bits: '0x', signature: '0x' };
  }
  if (!qc.pendingPolicySig) {
    throw new Error(`block ${qc.blockNum} is a transition block, and its certificate has no pending half`);
  }
  if (!policy) throw new Error('a transition block needs the pending policy to prove its root');
  if (policy.generation !== fd.last_pending_finalizer_policy_generation) {
    throw new Error(
      `pending policy is generation ${policy.generation}, ` +
        `the block names ${fd.last_pending_finalizer_policy_generation}`,
    );
  }
  return { policy: toHex0x(packFinalizerPolicy(policy)), ...strongHalf(qc.pendingPolicySig, 'pending') };
}

/** The `Proof` struct `AlcorWithdrawals.release` takes. */
export type ReleaseProof = {
  id: bigint;
  domain: bigint;
  token: string;
  recipient: string;
  amount: bigint;
  deadline: bigint;
  fee: bigint;
  memo: string;
  recvSequence: bigint;
  witness: string;
  actionSiblings: string[];
  /** Bit i set: the node is the LEFT child at step i. Decimal, a uint256 on chain. */
  actionPath: string;
  actionMroot: string;
  majorVersion: number;
  minorVersion: number;
  blockNum: number;
  timestamp: number;
  parentTimestamp: number;
  finalityDigest: string;
  treeSiblings: string[];
  treePath: string;
  finalityMroot: string;
};

/**
 * A merkle branch in the shape the Solidity fold consumes: the siblings, and the
 * side the node is on at each step as one bitmask — bit i set means left. One
 * word of calldata instead of a padded word per step.
 */
export function toSolidityBranch(steps: Step[]): { siblings: string[]; path: string } {
  if (steps.length > 256) throw new Error(`a branch of ${steps.length} steps does not fit a uint256 path`);
  let path = 0n;
  steps.forEach((s, i) => {
    if (s.left) path |= 1n << BigInt(i);
  });
  return { siblings: steps.map((s) => hex0x(s.sibling)), path: path.toString() };
}

/** Whether step `i` of a Solidity branch path has the node on the left. */
export const leftAt = (path: string, i: number): boolean => ((BigInt(path) >> BigInt(i)) & 1n) === 1n;

export type BuildReleaseInput = {
  chain: SlotEpoch;
  /** Every trace of the block the withdrawal was burned in. */
  traces: ActionTrace[];
  /** Which of them is the `wdlog`; defaults to the only one on the bridge. */
  bridgeAccount: string;
  block: { number: number; timestamp: string | number; parentTimestamp: string | number };
  finalityData: FinalityData;
  /** This block's own finality digest, as a later block reports it. */
  finalityDigest: string;
  /** A tree that has had this block's leaf appended. */
  tree: IncrementalTree;
  /** Which root to settle against; defaults to the tree's current root. */
  rootHex?: string;
  /**
   * Which of the block's `wdlog` actions to prove, counted in execution order.
   *
   * Defaults to the first, which is right for a block holding one withdrawal and
   * quietly wrong for a block holding two: the second would be proved with the
   * first one's payload, and the fold would succeed, because it is a valid proof
   * of the wrong withdrawal. A caller that knows which id it wants passes this.
   */
  wdlogOrdinal?: number;
};

/**
 * Assemble a complete `release` proof, checking every fold on the way.
 *
 * Two branches, and they are built from different things: the action branch from
 * the block's own receipts, the tree branch from the finality tree that spans
 * this block. Neither can be taken from a service — both are recomputed here and
 * verified against the roots they claim.
 */
export function buildReleaseProof(input: BuildReleaseInput): { vault: string; proof: ReleaseProof } {
  const ordered = receiptsInExecutionOrder(input.traces);
  const matches = blockWdlogs(input.traces, input.bridgeAccount);
  if (!matches.length) throw new Error(`no ${input.bridgeAccount}::wdlog action in this block`);

  const ordinal = input.wdlogOrdinal ?? 0;
  if (ordinal >= matches.length) {
    throw new Error(
      `block has ${matches.length} ${input.bridgeAccount}::wdlog action(s), asked for #${ordinal}`,
    );
  }
  const index = matches[ordinal].index;

  const wdlog = ordered[index];
  // The vault is signed into the payload but is not a proof field: the verifier
  // rebuilds the digest with its own. It travels beside the proof, so a caller
  // can pick the contract that will accept it.
  const { vault, ...payload } = decodeWdlog(wdlog.data);

  // 1. The action's digest folds to the block's action_mroot.
  const leaves = ordered.map((t) => actionDigestSavanna(t));
  const actionSteps = treeProof(leaves, index);
  const actionMroot = foldProof(leaves[index], actionSteps);
  if (toHex(actionMroot) !== input.finalityData.action_mroot) {
    throw new Error('action branch does not fold to the block action_mroot');
  }

  // 2. The finality leaf commits to that action_mroot, and folds to a root.
  const slot = (v: number | string) =>
    typeof v === 'number' ? v : timestampToSlot(input.chain, v);
  const leaf = finalityLeafBytes(input.chain, {
    majorVersion: input.finalityData.major_version,
    minorVersion: input.finalityData.minor_version,
    blockNum: input.block.number,
    timestamp: slot(input.block.timestamp),
    parentTimestamp: slot(input.block.parentTimestamp),
    finalityDigest: input.finalityDigest,
    actionMroot: input.finalityData.action_mroot,
  });

  const rootHex = input.rootHex !== undefined ? bare(input.rootHex) : toHex(input.tree.root());
  const treeSteps = input.tree.proof(leaf, rootHex);
  const reached = foldProof(leaf, treeSteps);
  if (toHex(reached) !== rootHex) {
    throw new Error('tree branch does not fold to the requested root');
  }

  const a = toSolidityBranch(actionSteps);
  const t = toSolidityBranch(treeSteps);

  const proof: ReleaseProof = {
    ...payload,
    recvSequence: wdlog.receipt!.recvSequence,
    witness: toHex0x(savannaWitness(wdlog.receipt!)),
    actionSiblings: a.siblings,
    actionPath: a.path,
    actionMroot: hex0x(input.finalityData.action_mroot),
    majorVersion: input.finalityData.major_version,
    minorVersion: input.finalityData.minor_version,
    blockNum: input.block.number,
    timestamp: slot(input.block.timestamp),
    parentTimestamp: slot(input.block.parentTimestamp),
    finalityDigest: hex0x(input.finalityDigest),
    treeSiblings: t.siblings,
    treePath: t.path,
    finalityMroot: hex0x(rootHex),
  };
  return { vault, proof };
}

/** sha256, re-exported so a caller need not reach for a hashing library. */
export { sha256 };
