/**
 * Freezing a Polygon deposit — the half of its proof that never goes stale.
 *
 * A milestone proof carries a Heimdall commit, and `polylightcl` takes a commit
 * only from the exact validator set it holds, which moves about hourly. So the
 * consensus half is built when someone asks for it (`src/polygon/proof.ts`,
 * from the API), under the set the client holds at that moment. What is frozen
 * here is the receipt: the block, the trie path and the log index, all fixed the
 * moment the block is final.
 */

import { proveReceipt } from '../../src/evm/receiptProof.ts';
import { activeExec, type Exec } from '../../src/evm/exec.ts';
import { hexToBytes } from '../../src/bsc/header.ts';
import { bare } from '../../src/proof/hex.ts';
import type { Frozen, LogToFreeze } from '../../src/proof/prover.ts';

export type MilestoneProverConfig = {
  evm: { id: string };
  accounts: { lightClient: string };
};

/**
 * How far below Bor's `finalized` tag a block must be before a proof exists. The
 * light client wants the block's milestone and the one after it, and a milestone
 * covers at most ten blocks (`max_milestone_proposition_length`), so ten below
 * the newest milestone's end always has a successor.
 */
const DEPTH = 10;

export class MilestoneProver {
  private cfg: MilestoneProverConfig;
  private exec: Exec;

  constructor(cfg: MilestoneProverConfig, exec: Exec = activeExec) {
    this.cfg = cfg;
    this.exec = exec;
  }

  /** The highest block whose milestone already has a successor. */
  async matureBelow(_head: number): Promise<number> {
    const finalized = await this.exec.rpc('eth_getBlockByNumber', ['finalized', false]);
    return Number(BigInt(finalized.number)) - DEPTH;
  }

  async freeze(p: LogToFreeze): Promise<Frozen> {
    const receipt = await this.exec.rpc('eth_getTransactionReceipt', [p.tx]);
    if (!receipt) throw new Error(`no receipt for ${p.tx}`);
    const blockNumber = Number(BigInt(receipt.blockNumber));
    const block = await this.exec.rpc('eth_getBlockByNumber', [receipt.blockNumber, false]);

    const proof = await proveReceipt(
      blockNumber,
      hexToBytes(block.receiptsRoot),
      Number(receipt.transactionIndex),
      { address: p.address, topic0: p.topic0 },
      this.exec,
    );

    const body = JSON.stringify({
      kind: p.kind,
      strategy: 'milestone',
      blockNumber,
      blockHash: block.hash,
      // The consensus half is built on request; see the file comment.
      gateway: [
        this.cfg.accounts.lightClient,
        String(block.hash).slice(2),
        bare(proof.keyHex),
        proof.nodesHex.map(bare),
        proof.logIndex,
      ],
    });
    return { body, blockNumber, signedBy: 'built on request' };
  }
}
