/**
 * What every way of proving a source chain's log has in common.
 *
 * The beacon path, Parlia, a Polygon milestone or checkpoint:
 * each turns a log into a frozen body in its own way, and the follower that
 * stores the result does not care which. These are the two shapes that cross
 * that line, and the one interface a prover the follower drives implements.
 */

/**
 * A log to freeze: a `Deposit` the gateway credits, or a `Voided` it refunds,
 * named by the transaction that emitted it and the log's address and topic.
 */
export type LogToFreeze = {
  /** The proof key: `d:<domain>:<nonce>` or `v:<id>`. */
  key: string;
  kind: 'deposit' | 'void';
  tx: string;
  address: string;
  topic0: string;
};

/** A frozen proof, ready to store. */
export type Frozen = {
  body: string;
  blockNumber: number;
  signedBy: string;
  /**
   * The sync committee a beacon-anchored proof was signed by: ~49 KB and the
   * same for every proof in its period, so stored once beside the proofs and
   * stitched back in when one is served. Absent where the proof carries its own
   * keys.
   */
  committee?: { period: number; keys: string; aggKey: string };
};

export interface Prover {
  /** The highest block whose logs can be frozen now; -1 when none can. */
  matureBelow(head: number): Promise<number>;
  freeze(p: LogToFreeze): Promise<Frozen>;
}
