/**
 * What the Telos side of the NEAR route takes, built from NEAR RPC:
 * `nearlightcl::bootstrap` / `addhead` and `neargateway::credit` / `voided`
 * (contracts/telos in the bridge repository; docs/NEAR.md there).
 *
 * The rules are nomicon's "Light Client" and nearcore's `block_header.rs` /
 * `merkle.rs`, walked live on mainnet first (research/near in the bridge
 * repository). Nothing here is trusted: the light client and the gateway
 * recompute every hash and check every signature.
 */
import { createHash } from 'node:crypto';

import { nearRpc } from './rpc.ts';

// ---- base58, borsh, sha256 ----------------------------------------------------------------

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function fromBase58(s: string): Buffer {
  let n = 0n;
  for (const c of s) {
    const d = ALPHABET.indexOf(c);
    if (d < 0) throw new Error(`not base58: ${s}`);
    n = n * 58n + BigInt(d);
  }
  const bytes: number[] = [];
  while (n > 0n) { bytes.unshift(Number(n & 255n)); n >>= 8n; }
  for (const c of s) { if (c !== '1') break; bytes.unshift(0); }
  return Buffer.from(bytes);
}

export function toBase58(b: Uint8Array): string {
  let n = BigInt(`0x${Buffer.from(b).toString('hex') || '0'}`);
  let s = '';
  while (n > 0n) { s = ALPHABET[Number(n % 58n)] + s; n /= 58n; }
  for (const x of b) { if (x !== 0) break; s = `1${s}`; }
  return s;
}

const sha256 = (...parts: Uint8Array[]) => {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
};
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
/** A base58 hash, as the RPC prints it, in the hex the actions take. */
const h = (s: string) => hex(fromBase58(s));

const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64 = (n: bigint | number | string) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const u128 = (n: bigint | string) => {
  const v = BigInt(n), b = Buffer.alloc(16);
  b.writeBigUInt64LE(v & ((1n << 64n) - 1n)); b.writeBigUInt64LE(v >> 64n, 8);
  return b;
};
const str = (s: string) => { const b = Buffer.from(s, 'utf8'); return Buffer.concat([u32(b.length), b]); };

/** `ValidatorStakeView` V1 (tag 0) { account_id, public_key, stake }. Telos refuses any other version. */
function validatorStake(v: any): Buffer {
  if ((v.validator_stake_struct_version ?? 'V1') !== 'V1') throw new Error(`unknown ValidatorStakeView ${v.validator_stake_struct_version}`);
  const [curve, body] = String(v.public_key).split(':');
  const tag = curve === 'ed25519' ? 0 : curve === 'secp256k1' ? 1 : -1;
  if (tag < 0) throw new Error(`unknown key type ${curve}`);
  return Buffer.concat([Buffer.of(0), str(v.account_id), Buffer.of(tag), fromBase58(body), u128(v.stake)]);
}

/** borsh(Vec<ValidatorStakeView>), hex: a producer set as the light client takes it. */
export const producersBytes = (bps: any[]) => hex(Buffer.concat([u32(bps.length), ...bps.map(validatorStake)]));

function innerLiteBytes(l: any): Buffer {
  return Buffer.concat([
    u64(l.height), fromBase58(l.epoch_id), fromBase58(l.next_epoch_id), fromBase58(l.prev_state_root),
    fromBase58(l.outcome_root), u64(l.timestamp_nanosec ?? l.timestamp), fromBase58(l.next_bp_hash), fromBase58(l.block_merkle_root),
  ]);
}

/** sha256(sha256(sha256(inner_lite) ‖ inner_rest_hash) ‖ prev_hash), base58. */
export const blockHashOf = (lite: { inner_lite: any; inner_rest_hash: string; prev_block_hash: string }) =>
  toBase58(sha256(sha256(sha256(innerLiteBytes(lite.inner_lite)), fromBase58(lite.inner_rest_hash)), fromBase58(lite.prev_block_hash)));

// ---- action shapes ------------------------------------------------------------------------------

export type HeaderLite = { prev_block_hash: string; inner_rest_hash: string; inner: Record<string, string | number> };

/** A block's light view (`block_header_lite`, or a light-client block) as the actions take it. */
export function headerLite(lite: { inner_lite: any; inner_rest_hash: string; prev_block_hash: string }): HeaderLite {
  const l = lite.inner_lite;
  return {
    prev_block_hash: h(lite.prev_block_hash),
    inner_rest_hash: h(lite.inner_rest_hash),
    inner: {
      height: Number(l.height), epoch_id: h(l.epoch_id), next_epoch_id: h(l.next_epoch_id),
      prev_state_root: h(l.prev_state_root), outcome_root: h(l.outcome_root), timestamp: String(l.timestamp_nanosec),
      next_bp_hash: h(l.next_bp_hash), block_merkle_root: h(l.block_merkle_root),
    },
  };
}

/** Blocks per epoch, mainnet and testnet. */
export const EPOCH_LENGTH = 43_200;

const path = (p: { hash: string; direction: string }[]) => p.map((s) => ({ hash: h(s.hash), left: s.direction === 'Left' }));

/**
 * The fewest approvals that clear two thirds, largest stakes first, sent in
 * index order. Nothing commits to the approvals a block carries, so the rest
 * are dropped: every signature costs CPU on Telos.
 */
export function fewestApprovals(lc: any, producers: any[]): { index: number; signature: string }[] {
  const total = producers.reduce((a, p) => a + BigInt(p.stake), 0n);
  const signed = producers
    .map((p, i) => ({ i, stake: BigInt(p.stake), sig: lc.approvals_after_next[i] as string | null }))
    .filter((x) => x.sig && x.sig.startsWith('ed25519:'))
    .sort((a, b) => (b.stake > a.stake ? 1 : b.stake < a.stake ? -1 : 0));
  let s = 0n;
  const out: typeof signed = [];
  for (const x of signed) {
    out.push(x);
    s += x.stake;
    if (s * 3n > total * 2n) break;
  }
  if (s * 3n <= total * 2n) throw new Error(`near: block ${lc.inner_lite.height} carries approvals of only ${s} of ${total}`);
  return out.sort((a, b) => a.i - b.i).map((x) => ({ index: x.i, signature: hex(fromBase58(x.sig!.split(':')[1])) }));
}

/** The producers of the epoch a block is in, in their order: what its approvals index. */
export const producersAt = (rpc: string[], blockHash: string): Promise<any[]> =>
  nearRpc(rpc, 'EXPERIMENTAL_validators_ordered', [blockHash]);

/** `addhead`'s arguments for a light-client block (`next_light_client_block`). */
export async function addheadArgs(rpc: string[], payer: string, lc: any) {
  const hash = blockHashOf(lc);
  return {
    hash,
    height: Number(lc.inner_lite.height),
    epoch: String(lc.inner_lite.epoch_id),
    args: {
      payer,
      block: headerLite(lc),
      next_block_inner_hash: h(lc.next_block_inner_hash),
      next_bps: lc.next_bps ? producersBytes(lc.next_bps) : '',
      approvals: fewestApprovals(lc, await producersAt(rpc, hash)),
    },
  };
}

/** A block at `height` or, where none was produced, the first one after it. */
async function blockFrom(rpc: string[], height: number): Promise<any> {
  for (let n = height; n < height + 50; n++) {
    try {
      return (await nearRpc(rpc, 'block', { block_id: n })).header;
    } catch (e) {
      if (!/UNKNOWN_BLOCK|DB Not Found|not found/i.test((e as Error).message)) throw e;
    }
  }
  throw new Error(`near: no block from ${height} to ${height + 50}`);
}

/**
 * The owner's `bootstrap`, one epoch back: a block early in the previous epoch,
 * that epoch's producers (taken on trust — that is the bootstrap) and the
 * running epoch's, which must hash to the block's `next_bp_hash`. The relayer
 * then walks from the block with `next_light_client_block`. `rpc` must reach
 * blocks an epoch old (an archival node, or a node holding a few epochs).
 */
export async function bootstrapArgs(rpc: string[]) {
  const { epoch_start_height: start } = await nearRpc(rpc, 'validators', [null]);
  const block = await blockFrom(rpc, Number(start) - EPOCH_LENGTH + 600);
  const inNext = await blockFrom(rpc, Number(start) + 10);
  if (inNext.epoch_id !== block.next_epoch_id) throw new Error('near: the running epoch is not the one after the bootstrap block');
  const lite = (await nearRpc(rpc, 'EXPERIMENTAL_light_client_block_proof', { block_hash: block.hash, light_client_head: inNext.hash })).block_header_lite;
  if (blockHashOf(lite) !== block.hash) throw new Error('near: the light view of the bootstrap block does not hash to it');
  const bps = await producersAt(rpc, block.hash);
  const nextBps = await producersAt(rpc, inNext.hash);
  if (hex(sha256(Buffer.from(producersBytes(nextBps), 'hex'))) !== h(block.next_bp_hash)) {
    throw new Error('near: the next epoch\'s producers do not hash to the bootstrap block\'s next_bp_hash');
  }
  return { height: Number(block.height), hash: String(block.hash), args: { block: headerLite(lite), bps: producersBytes(bps), next_bps: producersBytes(nextBps) } };
}

/** PartialExecutionStatus: 0 Unknown, 1 Failure, 2 SuccessValue, 3 SuccessReceiptId. */
function status(s: any): { status: number; value: string } {
  if (s === 'Unknown') return { status: 0, value: '' };
  if ('Failure' in s) return { status: 1, value: '' };
  if ('SuccessValue' in s) return { status: 2, value: Buffer.from(s.SuccessValue, 'base64').toString('hex') };
  if ('SuccessReceiptId' in s) return { status: 3, value: h(s.SuccessReceiptId) };
  throw new Error(`near: unknown outcome status ${JSON.stringify(s)}`);
}

/**
 * `neargateway::credit` / `voided` arguments: a receipt's outcome proved down
 * from a head the light client stores (`headHash` at `headHeight`), the vault's
 * log at index `log`.
 */
export async function receiptProofArgs(rpc: string[], o: {
  payer: string; receipt: string; receiver: string; headHash: string; headHeight: number; log: number;
}) {
  const p = await nearRpc(rpc, 'EXPERIMENTAL_light_client_proof', {
    type: 'receipt', receipt_id: o.receipt, receiver_id: o.receiver, light_client_head: o.headHash,
  });
  const out = p.outcome_proof.outcome;
  return {
    payer: o.payer,
    head: o.headHeight,
    outcome: {
      id: h(p.outcome_proof.id),
      receipt_ids: (out.receipt_ids as string[]).map(h),
      gas_burnt: String(out.gas_burnt),
      tokens_burnt: String(out.tokens_burnt),
      executor_id: out.executor_id,
      ...status(out.status),
      logs: out.logs,
    },
    outcome_proof: path(p.outcome_proof.proof),
    outcome_root_proof: path(p.outcome_root_proof),
    block: headerLite(p.block_header_lite),
    block_proof: path(p.block_proof),
    log: o.log,
  };
}
