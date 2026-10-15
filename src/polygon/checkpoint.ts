/**
 * Building the half of a Polygon proof that is not a receipt.
 *
 * A checkpoint is a merkle root over a run of Bor blocks, stored by the
 * `RootChain` contract on the settlement chain after that contract has checked
 * the Heimdall signatures behind it. So proving a Polygon deposit means reading
 * L1 storage and then walking one small tree — no Polygon consensus is verified
 * anywhere, by us or by the contract.
 *
 * Everything here was measured against live mainnet before it was written:
 *
 *   leaf    keccak(uint256 number ‖ uint256 time ‖ txRoot ‖ receiptsRoot)
 *   tree    plain binary, leaves padded to a power of two with ZERO hashes
 *   slots   headerBlocks[id] at mapping slot 5: root, start, end, createdAt, proposer
 *
 * The padding rule is the one thing here that cannot be guessed: a 256-block
 * checkpoint folds identically whether the odd node is duplicated or zero-filled,
 * and a 768-block one — every other checkpoint — does not. Both were rebuilt
 * against a live root; only zero padding matched.
 */

import { keccak_256 } from '@noble/hashes/sha3';

import type { Exec } from '../evm/exec.ts';

const ZERO = new Uint8Array(32);

export const toHex = (b: Uint8Array): string =>
  '0x' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

const fromHex = (h: string): Uint8Array =>
  Uint8Array.from(Buffer.from(h.replace(/^0x/, ''), 'hex'));

/** A uint256 word, which is how both the leaf and a mapping key are padded. */
const word = (v: bigint | number | string): Uint8Array =>
  fromHex(BigInt(v).toString(16).padStart(64, '0'));

const hash = (...parts: Uint8Array[]): Uint8Array => {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const buf = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    buf.set(p, at);
    at += p.length;
  }
  return keccak_256(buf);
};

/** Where Solidity puts `headerBlocks[id]`. The struct follows in the next slots. */
export const mappingSlot = (id: bigint, slot: number): bigint =>
  BigInt(toHex(hash(word(id), word(slot))));

export type Checkpoint = {
  id: bigint;
  root: string;
  start: number;
  end: number;
  createdAt: number;
};

const SELECTORS = {
  currentHeaderBlock: toHex(keccak_256(new TextEncoder().encode('currentHeaderBlock()'))).slice(0, 10),
  headerBlocks: toHex(keccak_256(new TextEncoder().encode('headerBlocks(uint256)'))).slice(0, 10),
};

async function headerBlocks(l1: Exec, rootChain: string, id: bigint): Promise<Checkpoint | null> {
  const data = SELECTORS.headerBlocks + BigInt(id).toString(16).padStart(64, '0');
  const raw = await l1.rpc('eth_call', [{ to: rootChain, data }, 'latest']);
  if (!raw || raw === '0x') return null;
  const at = (k: number) => BigInt('0x' + raw.slice(2 + 64 * k, 2 + 64 * (k + 1)));
  const root = '0x' + raw.slice(2, 66);
  if (at(0) === 0n) return null;
  return { id, root, start: Number(at(1)), end: Number(at(2)), createdAt: Number(at(3)) };
}

/**
 * The checkpoint covering `borBlock`, found by walking back from the newest.
 *
 * Ids advance by 10 000 whatever the range covers, so they cannot be indexed by
 * block number — the walk is the lookup. `limit` bounds it: a block older than
 * that many checkpoints is a rescue, not a deposit, and deserves to be asked for
 * explicitly rather than found after ten thousand round trips.
 */
export async function findCheckpoint(
  l1: Exec,
  rootChain: string,
  borBlock: number,
  limit = 400,
): Promise<Checkpoint> {
  const current = BigInt(await l1.rpc('eth_call', [
    { to: rootChain, data: SELECTORS.currentHeaderBlock },
    'latest',
  ]));

  for (let i = 0n; i < BigInt(limit); i++) {
    const cp = await headerBlocks(l1, rootChain, current - i * 10_000n);
    if (!cp) continue;
    if (borBlock >= cp.start && borBlock <= cp.end) return cp;
    // Ranges descend as ids do, so once the window is entirely above the target
    // there is no point continuing past the one that is entirely below it.
    if (cp.end < borBlock) break;
  }
  throw new Error(
    `no checkpoint covers Bor block ${borBlock} within ${limit} of the newest — ` +
      `either it is not checkpointed yet, or it is old enough to need an explicit id`,
  );
}

export type StorageProof = {
  account: string[];
  root: string[];
  start: string[];
  end: string[];
  /** What the slots hold, so the caller can check before paying for a push. */
  values: { root: string; start: number; end: number };
};

/**
 * The account and slot proofs for one checkpoint, at one settlement-chain block.
 *
 * `blockTag` is the block whose state root the light client has already proved.
 * It need not be near the checkpoint: storage persists, so any block after the
 * checkpoint landed will do — which is what makes an old deposit provable with a
 * fresh header instead of an archive one.
 */
export async function checkpointProof(
  l1: Exec,
  rootChain: string,
  slot: number,
  id: bigint,
  blockTag: string,
): Promise<StorageProof> {
  const base = mappingSlot(id, slot);
  const keys = [base, base + 1n, base + 2n].map((s) => '0x' + s.toString(16).padStart(64, '0'));
  const proof = await l1.rpc('eth_getProof', [rootChain, keys, blockTag]);
  if (!proof?.accountProof) throw new Error(`no account proof for ${rootChain} at ${blockTag}`);

  const [root, start, end] = proof.storageProof;
  return {
    account: proof.accountProof,
    root: root.proof,
    start: start.proof,
    end: end.proof,
    values: {
      root: '0x' + BigInt(root.value).toString(16).padStart(64, '0'),
      start: Number(BigInt(start.value)),
      end: Number(BigInt(end.value)),
    },
  };
}

export type BorLeaf = {
  number: number;
  time: number;
  txRoot: string;
  receiptsRoot: string;
  branch: string[];
};

/** The four fields the checkpoint's tree commits to, hashed into a leaf. */
const leafOf = (b: { number: string; timestamp: string; transactionsRoot: string; receiptsRoot: string }) =>
  hash(word(b.number), word(b.timestamp), fromHex(b.transactionsRoot), fromHex(b.receiptsRoot));

/**
 * The merkle branch for one Bor block inside a checkpoint.
 *
 * Every block in the range has to be fetched, because a merkle proof needs the
 * whole tree: 256 to 1536 headers, in batches. That is the price of this route
 * being archive-free — the data is headers, which any node serves forever, and
 * the cost is round trips rather than a provider tier.
 *
 * The rebuilt root is returned so the caller can compare it with what L1 says
 * before pushing anything. A mismatch here means the leaf format moved, and
 * finding that out on chain would cost a failed transaction and tell you less.
 */
export async function merkleBranch(
  bor: Exec,
  cp: Checkpoint,
  target: number,
  batch = 32,
): Promise<{ leaf: BorLeaf; root: string }> {
  if (target < cp.start || target > cp.end) {
    throw new Error(`block ${target} is outside checkpoint ${cp.id} (${cp.start}…${cp.end})`);
  }

  const blocks: any[] = [];
  for (let n = cp.start; n <= cp.end; n += batch) {
    const want = [];
    for (let k = 0; k < batch && n + k <= cp.end; k++) {
      want.push(bor.rpc('eth_getBlockByNumber', ['0x' + (n + k).toString(16), false]));
    }
    const got = await Promise.all(want);
    for (const b of got) {
      if (!b) throw new Error(`Bor block ${n} is missing from this endpoint`);
      blocks.push(b);
    }
  }

  const leaves = blocks.map(leafOf);
  let size = 1;
  while (size < leaves.length) size *= 2;

  let level: Uint8Array[] = leaves.slice();
  while (level.length < size) level.push(ZERO);

  let index = target - cp.start;
  const branch: string[] = [];
  while (level.length > 1) {
    branch.push(toHex(level[index ^ 1]));
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(hash(level[i], level[i + 1]));
    level = next;
    index >>= 1;
  }

  const b = blocks[target - cp.start];
  return {
    leaf: {
      number: Number(BigInt(b.number)),
      time: Number(BigInt(b.timestamp)),
      txRoot: b.transactionsRoot,
      receiptsRoot: b.receiptsRoot,
      branch,
    },
    root: toHex(level[0]),
  };
}
