/**
 * Assemble a complete ETH -> Wire proof bundle from live beacon + execution data.
 *
 * Two modes, same machinery:
 *
 *   finalized   the committee signed a header whose state finalizes the block we
 *               prove. Two branches (finality, execution). ~13 min behind, and
 *               only ever an epoch-boundary block.
 *   optimistic  the committee signed the block we prove as head. One branch
 *               (execution). ~24 s behind, any block — but head is not final, so
 *               the caller waits N confirmations and re-checks the block is still
 *               canonical. This is what an exchange does before crediting.
 *
 * Everything is cross-checked here, before anything is pushed: the aggregate
 * signature is verified off-chain, every branch must fold to its claimed root,
 * and the rebuilt receipts trie must match the signed receipts_root. A bundle
 * that leaves this function is one the contract should accept — if it doesn't,
 * the bug is on-chain, which is a much shorter search.
 */
import { ssz } from '@lodestar/types';
import { Tree } from '@chainsafe/persistent-merkle-tree';
import { FINALIZED_ROOT_GINDEX_ELECTRA, BLOCK_BODY_EXECUTION_PAYLOAD_GINDEX } from '@lodestar/params';

import { BeaconClient, periodOfSlot } from './beacon.ts';
import { branchFor, type Branch } from './sszBranch.ts';
import { proveReceipt, type ReceiptProof } from './receiptProof.ts';
import { checkCanonical, type CanonicalCheck } from './canonical.ts';
import { encodeG1ToAntelope, encodeG2ToAntelope } from '../savanna/encoding.ts';
import { DOMAIN_SYNC_COMMITTEE, computeDomain, computeSigningRoot, verifySyncCommittee } from './verify.ts';
import { toHex, fromHex, bare } from '../proof/hex.ts';
import { EXEC_URLS, EVM } from '../config.ts';

/**
 * An SSZ uint64 leaf: little-endian in the low eight bytes, zero-padded to 32.
 *
 * `block_number` is a basic type, so its leaf is the value itself rather than a
 * hash of it — which is exactly why it needs a branch to be believed.
 */
function uint64Leaf(v: number | bigint): Uint8Array {
  const out = new Uint8Array(32);
  new DataView(out.buffer).setBigUint64(0, BigInt(v), true);
  return out;
}

export type BundleMode = 'finalized' | 'optimistic';
export type Committee = { period: number; size: number; keysHex: string };

/** Everything updcommit needs to rotate trustlessly into `period`. */
export type CommitteeUpdate = Committee & {
  aggKeyHex: string;
  /** the header the CURRENT committee signed; empty array means bootstrap */
  signedHeader: HeaderFields[];
  sigHex: string;
  bitsHex: string;
  branch: string[];
};

/** Everything proveevent needs: the contract derives the signing root itself. */
export type HeaderFields = {
  slot: number; proposer_index: number;
  parent_root: string; state_root: string; body_root: string;
};

export type EventProof = {
  /** the header the committee actually signed — always the attested one */
  signed_header: HeaderFields;
  /** empty for an optimistic proof; one header for a finalized one */
  finalized: HeaderFields[];
  /**
   * Beacon headers from the proved block up to (not including) the signed one,
   * ascending. Its length is the confirmation depth the contract will believe,
   * because the contract hashes the `parent_root` links itself.
   */
  ancestry: HeaderFields[];
  finality_branch: string[];
  domainHex: string;
  receiptsRootHex: string;
  receiptsBranch: string[];
  /** Proved, not asserted: the light client indexes rows by this. */
  blockNumber: number;
  numberBranch: string[];
  /** Proved, not asserted: this is the light client's primary key. */
  blockHashHex: string;
  hashBranch: string[];
  execBranch: string[];
  /** Proved for the OP Stack route, which reaches its evidence through L1 state. */
  stateRootHex: string;
  stateBranch: string[];
  logIndex: number;
};

export type ProofBundle = {
  mode: BundleMode;
  source: { beacon: string; exec: string; network: string; fork: string };
  slots: { attested: number; finalized: number | null; signature: number; period: number };
  canonical?: CanonicalCheck;
  committee: CommitteeUpdate;
  bls: { msgHex: string; sigHex: string; bitsHex: string; signedCount: number; committeeSize: number };
  ssz: Branch[];
  mpt: ReceiptProof;
  /** the same proof, shaped for the linked on-chain verifier */
  event: EventProof;
};

/** A beacon header in the shape the contract's ABI expects. */
const headerFields = (h: any): HeaderFields => ({
  slot: Number(h.slot),
  proposer_index: Number(h.proposer_index),
  parent_root: bare(h.parent_root),
  state_root: bare(h.state_root),
  body_root: bare(h.body_root),
});

/**
 * The committee for a period, with the proof that it is the next_sync_committee
 * of the period before it.
 *
 * The update for period P-1 carries all of it at once: the committee itself, the
 * branch, the header its own committee attested to, and that committee's
 * signature. So a rotation needs exactly one API call.
 */
export async function committeeBlob(beacon: BeaconClient, period: number): Promise<CommitteeUpdate> {
  const { pubkeys, branch, update } = await beacon.committeeForPeriod(period);
  const blob = new Uint8Array(pubkeys.length * 96);
  pubkeys.forEach((pk, i) => blob.set(encodeG1ToAntelope(fromHex(pk)), i * 96));
  return {
    period,
    size: pubkeys.length,
    keysHex: toHex(blob),
    aggKeyHex: toHex(encodeG1ToAntelope(fromHex(update.next_sync_committee.aggregate_pubkey))),
    signedHeader: [headerFields(update.attested_header.beacon)],
    sigHex: toHex(encodeG2ToAntelope(fromHex(update.sync_aggregate.sync_committee_signature))),
    bitsHex: toHex(fromHex(update.sync_aggregate.sync_committee_bits)),
    branch: branch.map(bare),
  };
}

/**
 * The arguments of the `updcommit` that installs `period`'s committee.
 *
 * The committee taking over is signed into place by the committee before it,
 * which is the one the contract already holds; both key sets travel because the
 * contract re-derives each root rather than trusting either. The update must be
 * a finality update whose finalized header is in the signing period — the
 * contract installs a committee from nothing less, as the spec does — so that is
 * checked here, before a transaction is spent on it.
 */
export async function rotationArgs(
  beacon: BeaconClient,
  period: number,
): Promise<{ args: unknown[]; size: number; signedSlot: number }> {
  const incoming = await committeeBlob(beacon, period);
  const signers = await committeeBlob(beacon, period - 1);

  const { update } = await beacon.committeeForPeriod(period);
  const finalized = update.finalized_header?.beacon;
  const signingPeriod = periodOfSlot(Number(update.attested_header.beacon.slot));
  if (!finalized || Number(finalized.slot) === 0 || periodOfSlot(Number(finalized.slot)) !== signingPeriod) {
    throw new Error(
      `the update carrying committee ${period} has no finalized header in period ${signingPeriod}; ` +
        'the contract installs a committee only from a finality update',
    );
  }

  const args = [
    period,
    incoming.keysHex,
    incoming.aggKeyHex,
    incoming.signedHeader,
    incoming.sigHex,
    incoming.bitsHex,
    incoming.branch,
    signers.keysHex,
    signers.aggKeyHex,
    [headerFields(finalized)],
    update.finality_branch.map(bare),
  ];
  return { args, size: incoming.size, signedSlot: Number(incoming.signedHeader[0].slot) };
}

export type BuildOpts = {
  beaconUrl: string;
  /** transaction index or hash within the proved execution block; default: middle of the block */
  target?: number | string;
  /** an update captured earlier — the signature over it stays valid indefinitely */
  update?: any;
  /** prove a receipt carrying this log instead of `target` (must be whitelisted on chain) */
  wantLog?: { address: string; topic0: string };
  /**
   * The chain of beacon headers from the proved block up to the signed one.
   *
   * Supplying it turns a bare "the committee saw this block" into "the committee
   * saw K blocks built on top of it", which is what a confirmation count means
   * and what the contract can check for itself.
   *
   * It must come with `carrierUpdate`: once the committee signs a header K
   * blocks above the deposit, the signed header's execution payload is no longer
   * the one being proved, and the payload has to come from the deposit's own
   * block instead.
   */
  ancestry?: HeaderFields[];
  /** The update for the block being proved, when it is not the signed one. */
  carrierUpdate?: any;
};

/**
 * Build a bundle from a light-client update.
 *
 * The signature always covers the ATTESTED header; what differs per mode is
 * which header carries the execution payload we prove against, and therefore
 * how many branches link the two.
 */
async function assemble(mode: BundleMode, opts: BuildOpts): Promise<ProofBundle> {
  const beacon = new BeaconClient(opts.beaconUrl);

  const [genesisValidatorsRoot, update] = await Promise.all([
    beacon.genesisValidatorsRoot().then(fromHex),
    opts.update ?? (mode === 'finalized' ? beacon.finalityUpdate() : beacon.optimisticUpdate()),
  ]);

  const attested = update.attested_header;
  const signatureSlot = Number(update.signature_slot);
  const period = periodOfSlot(signatureSlot);

  // The fork at the SIGNATURE slot decides the domain — across a boundary the
  // attested header's own fork would be the wrong one.
  const fork = await beacon.forkAtSlot(signatureSlot);

  const { pubkeys } = await beacon.committeeForPeriod(period);
  const bits = fromHex(update.sync_aggregate.sync_committee_bits);
  const signature = fromHex(update.sync_aggregate.sync_committee_signature);
  const signerIdx = pubkeys.map((_, i) => i).filter((i) => (bits[i >> 3] >> (i & 7)) & 1);

  const attestedBeacon = ssz.phase0.BeaconBlockHeader.fromJson(attested.beacon);
  const domain = computeDomain(DOMAIN_SYNC_COMMITTEE, fromHex(fork.current_version), genesisValidatorsRoot);
  const signingRoot = computeSigningRoot(ssz.phase0.BeaconBlockHeader.hashTreeRoot(attestedBeacon), domain);

  if (!verifySyncCommittee(signerIdx.map((i) => fromHex(pubkeys[i])), signingRoot, signature)) {
    throw new Error('off-chain sync committee verification failed — wrong domain, fork or committee period');
  }

  // Which header carries the execution payload being proved.
  //
  // Four cases, and they differ in what links the payload to the signature:
  //   finalized            the carrier IS the finalized header
  //   finalized + ancestry the carrier is below the finalized header, linked by
  //                        a chain of parent_root — so it is an ancestor of
  //                        something final, and therefore final itself
  //   ancestry             the carrier is K blocks below the SIGNED header
  //   plain                the carrier IS the signed header
  //
  // The second case is not an optimisation. A finalized header is always an
  // epoch boundary, one slot in thirty-two, so without a chain every other block
  // is unprovable as final however long anyone waits.
  const carrier =
    mode === 'finalized' && !opts.ancestry?.length
      ? update.finalized_header
      : (opts.carrierUpdate?.attested_header ?? attested);
  const carrierBeacon = ssz.phase0.BeaconBlockHeader.fromJson(carrier.beacon);
  const execHeader = ssz.fulu.ExecutionPayloadHeader.fromJson(carrier.execution);

  const branches: Branch[] = [];
  if (mode === 'finalized') {
    // Links the finalized header to the state the committee attested to.
    //
    // The leaf is the FINALIZED header, which is only the carrier when no chain
    // was supplied. With one, the carrier is the proved block further down and
    // this branch still has to describe the tip.
    const finalBeacon = ssz.phase0.BeaconBlockHeader.fromJson(update.finalized_header.beacon);
    branches.push(branchFor(
      'finality',
      ssz.phase0.BeaconBlockHeader.hashTreeRoot(finalBeacon),
      update.finality_branch,
      FINALIZED_ROOT_GINDEX_ELECTRA,
      attestedBeacon.stateRoot,
    ));
  }
  // Links the execution payload to its beacon block body. In optimistic mode the
  // carrier IS the attested header, so this single branch is the whole link.
  branches.push(branchFor(
    'execution',
    ssz.fulu.ExecutionPayloadHeader.hashTreeRoot(execHeader),
    carrier.execution_branch,
    BLOCK_BODY_EXECUTION_PAYLOAD_GINDEX,
    carrierBeacon.bodyRoot,
  ));

  const blockNumber = Number(carrier.execution.block_number);
  const mpt = await proveReceipt(
    blockNumber,
    fromHex(carrier.execution.receipts_root),
    opts.target,
    opts.wantLog,
  );

  // Branches from individual payload-header fields up to the payload header
  // root. The beacon API serves none of these — they are internal to the header —
  // so they are built from the header itself and checked here like every other
  // branch.
  //
  // Three fields, not one. The predecessor proved only `receipts_root`, which is
  // enough to verify a log but not to say *where* it happened. The light client
  // stores rows keyed by block hash and indexed by block number, and neither may
  // be a value the submitter simply asserts: an unproved number would let a real
  // receipts root be filed under a height of the caller's choosing, and an
  // unproved hash is the primary key itself.
  const payloadView = ssz.fulu.ExecutionPayloadHeader.toView(execHeader);
  const payloadRoot = ssz.fulu.ExecutionPayloadHeader.hashTreeRoot(execHeader);
  const payloadTree = new Tree(payloadView.node);

  const payloadFieldBranch = (label: string, path: string, leaf: Uint8Array) => {
    const gindex = ssz.fulu.ExecutionPayloadHeader.getPathInfo([path]).gindex;
    const witnesses = payloadTree.getSingleProof(gindex).map((w) => new Uint8Array(w));
    return branchFor(label, leaf, witnesses.map(toHex), Number(gindex), payloadRoot);
  };

  const receiptsBranch = payloadFieldBranch('receipts', 'receiptsRoot', execHeader.receiptsRoot);
  const numberBranch = payloadFieldBranch('blockNumber', 'blockNumber', uint64Leaf(execHeader.blockNumber));
  const hashBranch = payloadFieldBranch('blockHash', 'blockHash', execHeader.blockHash);
  const stateBranch = payloadFieldBranch('stateRoot', 'stateRoot', execHeader.stateRoot);

  // With an ancestry chain the contract checks `body_root == ancestry[0].body_root`,
  // so the bottom of the chain must actually be the carrier. Catch a mismatch
  // here rather than as an opaque on-chain assertion.
  if (opts.ancestry?.length) {
    const bottom = opts.ancestry[0];
    if (bare(bottom.body_root) !== bare(carrier.beacon.body_root)) {
      throw new Error(
        `ancestry does not start at the proved block: chain bottom is slot ${bottom.slot}, ` +
          `carrier is slot ${carrier.beacon.slot}`,
      );
    }
  }

  const bundle: ProofBundle = {
    mode,
    source: { beacon: opts.beaconUrl, exec: EXEC_URLS[0], network: EVM.id, fork: fork.current_version },
    slots: {
      attested: Number(attested.beacon.slot),
      finalized: mode === 'finalized' ? Number(update.finalized_header.beacon.slot) : null,
      signature: signatureSlot,
      period,
    },
    committee: await committeeBlob(beacon, period),
    bls: {
      msgHex: toHex(signingRoot),
      sigHex: toHex(encodeG2ToAntelope(signature)),
      bitsHex: toHex(bits),
      signedCount: signerIdx.length,
      committeeSize: pubkeys.length,
    },
    ssz: branches,
    mpt,
    event: {
      signed_header: headerFields(attested.beacon),
      finalized: mode === 'finalized' ? [headerFields(update.finalized_header.beacon)] : [],
      finality_branch: mode === 'finalized' ? update.finality_branch.map(bare) : [],
      // Normalized like every other header: the beacon API returns 0x-prefixed
      // hex and the chain's hex parser does not accept the prefix.
      ancestry: (opts.ancestry ?? []).map(headerFields),
      domainHex: toHex(domain),
      receiptsRootHex: toHex(execHeader.receiptsRoot),
      receiptsBranch: receiptsBranch.siblings,
      stateRootHex: toHex(execHeader.stateRoot),
      stateBranch: stateBranch.siblings,
      blockNumber,
      numberBranch: numberBranch.siblings,
      blockHashHex: toHex(execHeader.blockHash),
      hashBranch: hashBranch.siblings,
      execBranch: branches[branches.length - 1].siblings,
      logIndex: mpt.logIndex,
    },
  };

  if (mode === 'optimistic') {
    bundle.canonical = await checkCanonical(blockNumber, carrier.execution.block_hash);
  }
  return bundle;
}

/** Finalized proof: ~13 min old, epoch-boundary blocks only, no reorg risk. */
export const buildProofBundle = (opts: BuildOpts) => assemble('finalized', opts);

/** Optimistic proof: ~24 s old, any block, carries reorg risk until confirmed. */
export const buildOptimisticBundle = (opts: BuildOpts) => assemble('optimistic', opts);
