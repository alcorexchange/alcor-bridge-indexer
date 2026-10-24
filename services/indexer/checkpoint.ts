/**
 * Freezing a Polygon deposit through a checkpoint: the fallback for what the
 * milestone path (`milestone.ts`) does not close. Two chains, no Polygon
 * consensus.
 *
 * Every other prover here works on one chain: Parlia reads a vote out of BSC's
 * own headers, the beacon path reads a committee signature out of Ethereum's,
 * the milestone path a Heimdall commit. This one verifies no Polygon consensus
 * at all — the evidence is a checkpoint that Heimdall's validators signed and the `RootChain`
 * contract on the SETTLEMENT chain already checked before storing it.
 *
 * So a frozen proof here is two halves that must agree on one block:
 *
 *   proveroot   the settlement chain's state root, from its light client
 *   gateway     the checkpoint read out of that state, then the Bor block read
 *               out of the checkpoint, then the receipt read out of the block
 *
 * Which imposes the one piece of sequencing in this file: the settlement block
 * has to be finalized AFTER the checkpoint landed, or the storage the proof
 * walks does not contain it yet. That is a wait, not an error, and it is
 * reported as one.
 */

import { buildProofBundle } from '../../src/evm/proofBundle.ts';
import { proveReceipt } from '../../src/evm/receiptProof.ts';
import { proverootArgs } from '../../src/proofs.ts';
import { checkpointProof, findCheckpoint, merkleBranch } from '../../src/polygon/checkpoint.ts';
import { execFor, type Exec } from '../../src/evm/exec.ts';
import type { EvmChain } from '../../src/chains/evm.ts';
import { bare, fromHex } from '../../src/proof/hex.ts';
import type { Frozen, LogToFreeze } from '../../src/proof/prover.ts';

export type CheckpointProverConfig = {
  /** The chain deposits happen on: Polygon or Amoy. */
  evm: EvmChain;
  /** Where it checkpoints, and whose light client proves those blocks. */
  settlement: EvmChain;
  accounts: { lightClient: string; gateway: string };
  beaconUrls: string[];
};

export class CheckpointProver {
  private cfg: CheckpointProverConfig;
  private bor: Exec;
  /**
   * Two lists for the settlement chain, because only one call needs the rare one.
   *
   * `eth_getProof` at a block minutes old is refused by almost every public
   * endpoint — measured: zero blocks of history on one Sepolia endpoint, sixteen
   * on two others, two hundred thousand on one. But that is the ONLY call that
   * needs history: finding a checkpoint is `eth_call` at `latest`, which anyone
   * serves. Sending both to the scarce endpoint earned an HTTP 429 within
   * minutes of the follower starting, which is how this split came to exist.
   */
  private l1: Exec;
  private archive: Exec;

  constructor(cfg: CheckpointProverConfig, bor: Exec) {
    if (!cfg.evm.checkpoint) throw new Error(`${cfg.evm.id} has no checkpoint parameters`);
    if (!cfg.beaconUrls.length) {
      throw new Error(
        `${cfg.evm.id} settles into ${cfg.settlement.id}, whose light client needs a beacon ` +
          `endpoint — Polygon has no beacon of its own, but its settlement chain does`,
      );
    }
    this.cfg = cfg;
    this.bor = bor;
    this.l1 = execFor(cfg.settlement.exec);
    this.archive = execFor(cfg.settlement.archive ?? cfg.settlement.exec);
  }

  /**
   * The highest Bor block a checkpoint already covers.
   *
   * Not the same as "provable right now": the settlement block that proof will
   * be taken against also has to be finalized past the checkpoint, and that is
   * checked in `freeze` where the block is actually known. Reporting it here
   * would mean fetching a finality update on every poll to answer a question
   * that only matters when there is something to freeze.
   */
  async matureBelow(_head: number): Promise<number> {
    const { rootChain } = this.cfg.evm.checkpoint!;
    const head = await this.bor.head();
    try {
      const cp = await findCheckpoint(this.l1, rootChain, head, 1);
      return cp.end;
    } catch {
      // The newest checkpoint is below the head, which is the normal case: walk
      // back until one covers something.
      for (const back of [600, 2000, 6000]) {
        try {
          const cp = await findCheckpoint(this.l1, rootChain, head - back, 8);
          return cp.end;
        } catch {
          continue;
        }
      }
      return -1;
    }
  }

  /**
   * Build both halves and the metadata to serve them with.
   *
   * Everything is checked here rather than on chain: the checkpoint's root is
   * rebuilt from Bor headers and compared with what settlement storage holds,
   * and the receipts trie is rebuilt against the root that rebuild produced. A
   * bundle that survives is one the gateway should accept.
   */
  async freeze(p: LogToFreeze): Promise<Frozen> {
    const params = this.cfg.evm.checkpoint!;

    const receipt = await this.bor.rpc('eth_getTransactionReceipt', [p.tx]);
    if (!receipt) throw new Error(`no receipt for ${p.tx}`);
    const blockNumber = Number(BigInt(receipt.blockNumber));

    const cp = await findCheckpoint(this.l1, params.rootChain, blockNumber);

    // The settlement side: whatever block is finalized now. It carries the state
    // the checkpoint has to be read out of, so it must be later than the
    // checkpoint — which for a fresh deposit means waiting about as long as the
    // settlement chain takes to finalize.
    const bundle = await buildProofBundle({ beaconUrl: this.cfg.beaconUrls[0] });
    const settlementBlock = await this.l1.rpc('eth_getBlockByHash', [bundle.event.blockHashHex, false]);
    if (!settlementBlock) {
      throw new Error(`${this.cfg.settlement.id} does not serve block ${bundle.event.blockHashHex}`);
    }
    if (Number(BigInt(settlementBlock.timestamp)) < cp.createdAt) {
      throw new Error(
        `checkpoint ${cp.id} landed after the finalized ${this.cfg.settlement.id} block ` +
          `${bundle.event.blockNumber} — not an error, just early by ` +
          `${cp.createdAt - Number(BigInt(settlementBlock.timestamp))}s`,
      );
    }

    const storage = await checkpointProof(
      this.archive,
      params.rootChain,
      params.headerBlocksSlot,
      cp.id,
      settlementBlock.number,
    );
    if (storage.values.root.toLowerCase() !== cp.root.toLowerCase()) {
      throw new Error(`the storage proof holds ${storage.values.root}, not ${cp.root}`);
    }

    const { leaf, root } = await merkleBranch(this.bor, cp, blockNumber);
    if (root.toLowerCase() !== cp.root.toLowerCase()) {
      throw new Error(`rebuilt checkpoint root ${root} != the stored ${cp.root}`);
    }

    const mpt = await proveReceipt(
      blockNumber,
      fromHex(leaf.receiptsRoot),
      Number(receipt.transactionIndex),
      { address: p.address, topic0: p.topic0 },
      this.bor,
    );

    const proveroot = proverootArgs(bundle, this.cfg.accounts.lightClient);
    const { keys, agg_key, ...slim } = proveroot;

    const body = JSON.stringify({
      kind: p.kind,
      strategy: 'checkpoint',
      committeePeriod: bundle.committee.period,
      // The Bor block, which is what a user recognises — not the settlement
      // block the proof happens to be taken against.
      blockNumber,
      blockHash: receipt.blockHash,
      signedBy: `${bundle.bls.signedCount}/${bundle.bls.committeeSize}`,
      checkpoint: { id: String(cp.id), start: cp.start, end: cp.end },
      settlementBlock: bundle.event.blockNumber,
      proveroot: slim,
      gateway: [
        this.cfg.accounts.gateway,
        String(this.cfg.evm.chainId),
        bare(bundle.event.blockHashHex),
        {
          id: String(cp.id),
          account: storage.account.map(bare),
          root: storage.root.map(bare),
          start: storage.start.map(bare),
          end: storage.end.map(bare),
        },
        {
          number: String(leaf.number),
          time: String(leaf.time),
          tx_root: bare(leaf.txRoot),
          receipts_root: bare(leaf.receiptsRoot),
          branch: leaf.branch.map(bare),
        },
        bare(mpt.keyHex),
        mpt.nodesHex.map(bare),
        mpt.logIndex,
      ],
    });

    return {
      body,
      blockNumber,
      signedBy: `${bundle.bls.signedCount}/${bundle.bls.committeeSize}`,
      committee: { period: bundle.committee.period, keys, aggKey: agg_key },
    };
  }
}
