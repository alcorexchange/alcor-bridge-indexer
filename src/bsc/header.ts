/**
 * A BSC header, re-encoded into the RLP the light client verifies.
 *
 * The contract is handed raw header bytes because the block hash is keccak over
 * them, and no JSON-RPC serves those bytes. So they are rebuilt field by field
 * from `eth_getBlockByNumber` — and then checked against the hash the node
 * itself reports. That check is the only reason rebuilding is safe: a fork that
 * appends a header field shows up here as a mismatch on the first block, rather
 * than as a block nobody can prove for reasons nobody can see.
 */

import { RLP } from '@ethereumjs/rlp';
import { keccak_256 } from '@noble/hashes/sha3';

import { execRpc } from '../evm/exec.ts';

export type RpcBlock = Record<string, any>;

export function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex;
  const padded = h.length % 2 ? '0' + h : h;
  const out = new Uint8Array(padded.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(padded.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export const toHex = (b: Uint8Array): string =>
  '0x' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/** An RLP quantity: minimal big-endian, so zero is the empty string. */
function quantity(hex: string): Uint8Array {
  const trimmed = (hex.startsWith('0x') ? hex.slice(2) : hex).replace(/^0+/, '');
  return trimmed === '' ? new Uint8Array() : hexToBytes(trimmed);
}

type Kind = 'data' | 'quantity';

/** The fifteen fields every BSC header has had since the beginning. */
const FIELDS: [string, Kind][] = [
  ['parentHash', 'data'],
  ['sha3Uncles', 'data'],
  ['miner', 'data'],
  ['stateRoot', 'data'],
  ['transactionsRoot', 'data'],
  ['receiptsRoot', 'data'],
  ['logsBloom', 'data'],
  ['difficulty', 'quantity'],
  ['number', 'quantity'],
  ['gasLimit', 'quantity'],
  ['gasUsed', 'quantity'],
  ['timestamp', 'quantity'],
  ['extraData', 'data'],
  ['mixHash', 'data'],
  ['nonce', 'data'],
];

/**
 * What later forks appended, in order.
 *
 * Taken only while they are present and contiguous: a gap would mean this list
 * has the order wrong, and encoding through it would produce a header that
 * hashes to nothing. The hash check catches that either way; failing on the gap
 * says why.
 */
const OPTIONAL: [string, Kind][] = [
  ['baseFeePerGas', 'quantity'],
  ['withdrawalsRoot', 'data'],
  ['blobGasUsed', 'quantity'],
  ['excessBlobGas', 'quantity'],
  ['parentBeaconBlockRoot', 'data'],
  ['requestsHash', 'data'],
];

export type EncodedHeader = {
  rlp: Uint8Array;
  hash: string;
  number: number;
  extraData: string;
  receiptsRoot: string;
  parentHash: string;
};

/** Re-encode a header and prove the encoding right by hashing it. */
export function encodeHeader(block: RpcBlock): EncodedHeader {
  const items: Uint8Array[] = [];
  for (const [key, kind] of FIELDS) {
    const v = block[key];
    if (v == null) throw new Error(`header ${block.number}: missing required field ${key}`);
    items.push(kind === 'data' ? hexToBytes(v) : quantity(v));
  }

  const seen: string[] = [];
  for (const [key, kind] of OPTIONAL) {
    const v = block[key];
    if (v == null) break;
    items.push(kind === 'data' ? hexToBytes(v) : quantity(v));
    seen.push(key);
  }

  const rlp = RLP.encode(items);
  const hash = toHex(keccak_256(rlp));
  if (hash !== block.hash) {
    throw new Error(
      `header ${block.number}: re-encoded to ${hash}, node says ${block.hash}. ` +
        `Optional fields taken: ${seen.join(', ') || 'none'}. ` +
        `A fork has probably appended a field this encoder does not know.`,
    );
  }

  return {
    rlp,
    hash,
    number: Number(BigInt(block.number)),
    extraData: block.extraData,
    receiptsRoot: block.receiptsRoot,
    parentHash: block.parentHash,
  };
}

/** Fetch one block and re-encode its header. */
export async function fetchHeader(urls: string[], block: number | string): Promise<EncodedHeader> {
  const tag = typeof block === 'number' ? '0x' + block.toString(16) : block;
  const json = await execRpc('eth_getBlockByNumber', [tag, false], urls);
  if (!json) throw new Error(`no block ${tag}`);
  return encodeHeader(json);
}
