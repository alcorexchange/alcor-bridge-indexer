/**
 * Freezing a BSC deposit into the artifact the Antelope side is handed.
 *
 * The Ethereum half of this indexer waits about thirteen minutes for a beacon
 * finality update and then builds a bundle whose ancestry grows with every
 * minute of delay. BSC has neither problem: a block is final about a second after
 * it is produced, and a vote that finalizes it sits two headers later, so an
 * artifact is two kilobytes and does not decay.
 *
 * What it still has is an epoch treadmill — the validator set is chained, one
 * `updateset` every 1000 blocks — and that is the relayer's duty, reported by the
 * API rather than done here. A frozen proof stays valid while its set does: it
 * names the epoch it verifies under, and the light client keeps a set for a week.
 */

import { antelopeRpc } from '../../src/net/antelope.ts';
import { proveReceipt } from '../../src/evm/receiptProof.ts';
import { activeExec, type Exec } from '../../src/evm/exec.ts';
import { jsonRpcAny } from '../../src/net/fetchJson.ts';
import { hexToBytes } from '../../src/bsc/header.ts';
import { proverootArgs } from '../../src/bsc/proof.ts';
import { bare } from '../../src/proof/hex.ts';
import type { Frozen, LogToFreeze } from './prover.ts';
/**
 * What building a Parlia proof actually needs.
 *
 * Narrower than `IndexerConfig`, which satisfies it structurally, so the relayer
 * can reuse the prover without pretending to be an indexer instance.
 */
export type ParliaProverConfig = {
  evm: { id: string };
  accounts: { lightClient: string };
};

/**
 * How far below the head a block has to be before a vote finalizing it exists.
 *
 * An attestation in header N names target N-1 and source N-2, so the vote that
 * finalizes B is normally in B+2. Three leaves room for a skipped slot without
 * making the freeze retry on the next poll instead.
 */
const FINALITY_LAG = 3;

export class ParliaProver {
  private cfg: ParliaProverConfig;
  /** This chain's nodes. Two provers in one process must not share one list. */
  private exec: Exec;

  constructor(cfg: ParliaProverConfig, exec: Exec = activeExec) {
    this.cfg = cfg;
    this.exec = exec;
  }

  /** The highest block whose logs can be proved right now. */
  async matureBelow(head: number): Promise<number> {
    return head - FINALITY_LAG;
  }

  /**
   * Build the two calls a deposit needs, and the metadata to serve them with.
   *
   * `proveroot` carries the block and the vote; `credit` carries the receipt.
   * Both are checked off-chain first — the receipts trie is rebuilt here and its
   * root compared with the block's — so a failure on chain is a disagreement
   * between two implementations rather than a hunt through a proof.
   */
  async freeze(p: LogToFreeze): Promise<Frozen> {
    const receipt = await this.exec.rpc('eth_getTransactionReceipt', [p.tx]);
    if (!receipt) throw new Error(`no receipt for ${p.tx}`);
    const blockNumber = Number(BigInt(receipt.blockNumber));

    const prove = await proverootArgs(this.cfg.evm.id, this.cfg.accounts.lightClient, blockNumber);
    const proof = await proveReceipt(
      blockNumber,
      hexToBytes(prove.vote.block.receiptsRoot),
      Number(receipt.transactionIndex),
      { address: p.address, topic0: p.topic0 },
      this.exec,
    );

    const signers = [...prove.vote.att.bitset.toString(2)].filter((c) => c === '1').length;
    const body = JSON.stringify({
      kind: p.kind,
      // No committee period: a Parlia proof carries its own keys, all 21 of them
      // in two kilobytes, so there is nothing to store once and stitch back in.
      strategy: 'parlia',
      blockNumber,
      blockHash: prove.vote.block.hash,
      signedBy: `${signers}/${prove.vote.active.set.length}`,
      epoch: prove.vote.active.epoch,
      finalizedBy: prove.vote.carrier,
      proveroot: prove.args,
      gateway: [
        this.cfg.accounts.lightClient,
        prove.vote.block.hash.slice(2),
        bare(proof.keyHex),
        proof.nodesHex.map(bare),
        proof.logIndex,
      ],
    });

    return { body, blockNumber, signedBy: `${signers}/${prove.vote.active.set.length}` };
  }
}

export type EpochBacklog = { stored: number; head: number; lag: number };

/** The light client's newest validator set: its epoch and the first target past its range. */
export type NewestSet = { epoch: number; activeUntil: number };

export async function newestSet(cfg: {
  savanna: { rpc: string[] };
  accounts: { lightClient: string };
}): Promise<NewestSet | null> {
  const page = await antelopeRpc(cfg.savanna, '/v1/chain/get_table_rows', {
    json: true,
    code: cfg.accounts.lightClient,
    scope: cfg.accounts.lightClient,
    table: 'vsets',
    reverse: true,
    limit: 1,
  });
  const row = page.rows?.[0];
  if (!row) return null;
  if (row.active_until === undefined) {
    throw new Error(`${cfg.accounts.lightClient} runs a build whose sets carry no range; reinstall it`);
  }
  return { epoch: Number(row.epoch_block), activeUntil: Number(row.active_until) };
}

/**
 * How far the light client's validator sets lag the chain.
 *
 * The sets are chained: the contract takes only the epoch right after its newest,
 * proved by that set, so a backlog is walked one epoch at a time and cannot be
 * jumped. At 1000 blocks of 0.45 seconds that is one every seven and a half
 * minutes — the standing cost of keeping a Parlia light client alive.
 */
export type ParliaTarget = {
  /**
   * `exec` is not optional and not decoration: the head has to come from THIS
   * chain's endpoints. Taking it from the active chain worked in a BSC instance
   * and lied in a Sepolia one — it divided Sepolia's head into BSC epochs and
   * reported a backlog of zero, which is the answer that stops anyone looking.
   */
  evm: { id: string; epochLength?: number; exec: string[] };
  savanna: { rpc: string[] };
  accounts: { lightClient: string };
};

export async function epochBacklog(cfg: ParliaTarget): Promise<EpochBacklog | null> {
  const epochLength = cfg.evm.epochLength;
  if (!epochLength) return null;

  const newest = await newestSet(cfg);
  if (!newest) return null;

  const stored = newest.epoch;
  const chainHead = Number(BigInt(await jsonRpcAny(cfg.evm.exec, 'eth_blockNumber', [])));
  const head = Math.floor(chainHead / epochLength) * epochLength;
  return { stored, head, lag: Math.max(0, (head - stored) / epochLength) };
}
