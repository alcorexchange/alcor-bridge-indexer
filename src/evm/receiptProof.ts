/**
 * Execution-layer receipt proofs.
 *
 * The receipts trie is rebuilt locally from the block's receipts and its root
 * must equal the `receipts_root` the beacon chain signed — that equality is the
 * whole reason a receipt proof means anything, so it is enforced here rather
 * than left to the caller.
 */
import { Trie } from '@ethereumjs/trie';
import { RLP } from '@ethereumjs/rlp';
import { activeExec, type Exec } from './exec.ts';
import { toHex, fromHex } from '../proof/hex.ts';

/**
 * Re-encode a JSON-RPC receipt into its canonical EIP-2718 trie value.
 *
 * Type `0x7e` is an OP Stack deposit transaction, and its receipt carries two
 * fields no other receipt has: `depositNonce` and, since Canyon,
 * `depositReceiptVersion`. Every OP Stack block opens with one — the system
 * transaction that writes the L1 attributes — so leaving them out does not
 * produce a slightly wrong receipt, it produces a receipts root that matches no
 * block on the chain. Which is exactly how this was found: the first Base proof
 * rebuilt a root that disagreed with the header's.
 *
 * The version field is included only when the node reports it, because a
 * pre-Canyon receipt genuinely has five fields rather than six.
 */
export function encodeReceipt(r: any): Uint8Array {
  const logs = r.logs.map((l: any) => [fromHex(l.address), l.topics.map(fromHex), fromHex(l.data)]);
  const fields: unknown[] = [
    BigInt(r.status) === 0n ? new Uint8Array(0) : Uint8Array.of(1),
    BigInt(r.cumulativeGasUsed),
    fromHex(r.logsBloom),
    logs,
  ];

  const type = Number(r.type);
  if (type === 0x7e && r.depositNonce != null) {
    fields.push(BigInt(r.depositNonce));
    if (r.depositReceiptVersion != null) fields.push(BigInt(r.depositReceiptVersion));
  }

  const body = RLP.encode(fields);
  return type === 0 ? body : new Uint8Array([type, ...body]);
}

/** Trie key for a transaction index (non-secure trie: RLP of the index). */
export const receiptKey = (index: number) => RLP.encode(index);

/** Where a log lives: which receipt of the block, and which log within it. */
export type LogLocation = { receiptIndex: number; logIndex: number };

/**
 * Find the first log in the block emitted by `address` with `topic0`.
 * Used to pick a transaction the contract's whitelist will actually accept.
 */
export function findLog(receipts: any[], address: string, topic0: string): LogLocation | null {
  for (const r of receipts) {
    const logs = r.logs ?? [];
    for (let i = 0; i < logs.length; i++) {
      const l = logs[i];
      if (l.address?.toLowerCase() !== address.toLowerCase()) continue;
      if (l.topics?.[0]?.toLowerCase() !== topic0.toLowerCase()) continue;
      return { receiptIndex: Number(r.transactionIndex), logIndex: i };
    }
  }
  return null;
}

export type ReceiptProof = {
  rootHex: string;
  keyHex: string;
  nodesHex: string[];
  receiptBytes: number;
  receiptIndex: number;
  /** which log of that receipt the caller cares about */
  logIndex: number;
  blockNumber: number;
  txHash: string;
};

/**
 * Prove one receipt of `blockNumber` against `receiptsRoot`.
 *
 * @param target  transaction index, or a transaction hash to look up in the block
 */
export async function proveReceipt(
  blockNumber: number,
  receiptsRoot: Uint8Array,
  target?: number | string,
  /** pick a receipt that carries this log, instead of `target` */
  wantLog?: { address: string; topic0: string },
  /** Which chain's nodes to ask. Defaults to the active one. */
  exec: Exec = activeExec,
): Promise<ReceiptProof> {
  const receipts = await exec.rpc('eth_getBlockReceipts', ['0x' + blockNumber.toString(16)]);
  if (!receipts?.length) throw new Error(`block ${blockNumber} has no receipts`);

  const trie = await Trie.create({ useKeyHashing: false });
  for (const r of receipts) await trie.put(receiptKey(Number(r.transactionIndex)), encodeReceipt(r));

  if (toHex(trie.root()) !== toHex(receiptsRoot)) {
    throw new Error(
      `rebuilt receipts root ${toHex(trie.root())} != signed receipts_root ${toHex(receiptsRoot)}`,
    );
  }

  let index: number;
  let logIndex = 0;

  // Both given: the receipt is pinned by `target`, and `wantLog` says which of
  // its logs matters. Searching the whole block instead would silently prove
  // somebody else's deposit that happens to sit in the same block.
  if (wantLog && target !== undefined && typeof target === 'number') {
    index = target;
    const logs = receipts.find((r: any) => Number(r.transactionIndex) === index)?.logs ?? [];
    const found = logs.findIndex((l: any) =>
      l.address?.toLowerCase() === wantLog.address.toLowerCase() &&
      l.topics?.[0]?.toLowerCase() === wantLog.topic0.toLowerCase());
    if (found === -1) {
      throw new Error(`transaction ${index} in block ${blockNumber} carries no matching log`);
    }
    logIndex = found;
  } else if (wantLog) {
    const found = findLog(receipts, wantLog.address, wantLog.topic0);
    if (!found) {
      throw new Error(
        `block ${blockNumber} has no ${wantLog.topic0.slice(0, 10)}… log from ${wantLog.address}`,
      );
    }
    index = found.receiptIndex;
    logIndex = found.logIndex;
  } else if (typeof target === 'string') {
    const found = receipts.findIndex((r: any) => r.transactionHash.toLowerCase() === target.toLowerCase());
    if (found === -1) throw new Error(`tx ${target} is not in block ${blockNumber}`);
    index = found;
  } else {
    index = target ?? Math.floor(receipts.length / 2);
  }

  const key = receiptKey(index);
  const nodes: Uint8Array[] = await trie.createProof(key);
  const value = await trie.get(key);
  if (!value) throw new Error(`no receipt at index ${index}`);

  return {
    rootHex: toHex(receiptsRoot),
    keyHex: toHex(key),
    nodesHex: nodes.map(toHex),
    receiptBytes: value.length,
    receiptIndex: index,
    logIndex,
    blockNumber,
    txHash: receipts[index].transactionHash,
  };
}
