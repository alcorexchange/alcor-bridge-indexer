/**
 * Reorg check for the optimistic path.
 *
 * An optimistic proof says 2/3 of the sync committee saw a block as head — not
 * that the chain can no longer abandon it. Waiting N slots and then re-asking the
 * execution layer whether that block number still has the same hash is exactly
 * what an exchange does before crediting a deposit: it does not make the block
 * final, it makes a reorg deep enough to matter increasingly unlikely.
 */
import { activeExec, type Exec } from './exec.ts';

export type CanonicalCheck = {
  ok: boolean;
  blockNumber: number;
  expectedHash: string;
  actualHash: string | null;
  headBlock: number;
  confirmations: number;
};

export async function checkCanonical(
  blockNumber: number,
  expectedHash: string,
  /** Which chain's nodes to ask. Defaults to the active one. */
  exec: Exec = activeExec,
): Promise<CanonicalCheck> {
  const [block, head] = await Promise.all([
    exec.rpc('eth_getBlockByNumber', ['0x' + blockNumber.toString(16), false]),
    exec.rpc('eth_blockNumber', []),
  ]);
  const actualHash: string | null = block?.hash ?? null;
  const headBlock = Number(head);
  return {
    ok: actualHash?.toLowerCase() === expectedHash.toLowerCase(),
    blockNumber,
    expectedHash,
    actualHash,
    headBlock,
    confirmations: Math.max(0, headBlock - blockNumber),
  };
}
