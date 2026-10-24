/**
 * State-history client, for the one thing only it can give: `finality_data`.
 *
 * A block's finality data is a by-product of *applying* the block, not a field
 * of it, so nodeop emits it on the state-history socket and nowhere else.
 * Rebuilding it from blocks alone would mean replaying the chain from genesis.
 *
 * The predecessor implementations both stop at the same place: they read
 * `has_pending_finalizer_policy` as a bare flag and throw if it is set, because
 * Wire has had one finalizer since genesis and a pending policy never appears.
 * On Telos it appears twice a day. What follows that flag is the entire pending
 * policy — `optional<finalizer_policy_with_string_key>` — which makes this the
 * bootstrap the light client needs: no snapshot, no chaining 100 diffs from the
 * Savanna transition block, just the policy handed over at a transition.
 *
 * Layout from Spring's own reflection:
 *   FC_REFLECT(finality_data_t, (major_version)(minor_version)
 *     (active_finalizer_policy_generation)(action_mroot)(reversible_blocks_mroot)
 *     (latest_qc_claim_block_num)(latest_qc_claim_finality_digest)
 *     (latest_qc_claim_timestamp)(base_digest)(pending_finalizer_policy)
 *     (last_pending_finalizer_policy_generation))
 *
 * Note `finalizer_policy_with_string_key`: over SHiP the keys are `PUB_BLS_…`
 * strings, not the raw 96 bytes a header diff carries. The digest is over the
 * raw form, so they get converted on the way in and this module hands back the
 * same shape either source produces.
 */

import WebSocket from 'ws';
import { ABI, Serializer } from '@wharfkit/antelope';

import { Reader as PackReader, type FinalizerPolicy } from './policyDiff.ts';
import { decodeBlsPublicKey, encodeG1ToAntelope } from './encoding.ts';

/**
 * Request variant indices, from the node's own state-history ABI.
 *
 * These are protocol-version dependent rather than chain dependent, so they are
 * worth re-checking against the ABI the socket sends as its first message if a
 * Spring upgrade ever makes the stream go quiet.
 */
/** `get_status_request_v1`: the v0 answer lacks the finality-data window. */
const REQUEST_STATUS_V1 = 4;
const REQUEST_BLOCKS_V1 = 3;
const REQUEST_BLOCKS_ACK = 2;

/**
 * How many results the node will send before waiting.
 *
 * It stops dead at this many un-acked messages — which looks exactly like a
 * hung socket if you are not expecting it. Each result must be acknowledged to
 * keep the stream moving.
 */
const MESSAGES_IN_FLIGHT = 16;

export type FinalityData = {
  major_version: number;
  minor_version: number;
  active_finalizer_policy_generation: number;
  action_mroot: string;
  reversible_blocks_mroot: string;
  latest_qc_claim_block_num: number;
  latest_qc_claim_finality_digest: string;
  latest_qc_claim_timestamp: number;
  base_digest: string;
  /** Present only on a block that proposes a new policy. The bootstrap. */
  pending_finalizer_policy?: FinalizerPolicy;
  last_pending_finalizer_policy_generation: number;
};

export type BlockPosition = { block_num: number; block_id: string };

export type ShipBlock = {
  head: BlockPosition;
  last_irreversible: BlockPosition;
  this_block: BlockPosition;
  finality_data?: FinalityData;
  /** Raw `transaction_trace[]`, left packed. Decoding needs the socket's ABI. */
  traces?: Uint8Array;
  /** The packed `signed_block`, when asked for: its header is where the block's time is. */
  block?: Uint8Array;
};

export type ShipStream = {
  /**
   * The state-history ABI, as the socket sends it in its first message.
   *
   * Worth keeping rather than hard-coding the trace layout: traces are a deep
   * variant structure that changes between Spring versions, and the node is the
   * only authority on which version it speaks.
   */
  abi: string;
  blocks: ShipBlock[];
};

function hex(b: Uint8Array): string {
  return Buffer.from(b).toString('hex');
}

/** Adds the SHiP-shaped reads on top of the shared fc::raw::pack reader. */
class ShipReader extends PackReader {
  digest(): string {
    return hex(this.bytes(32));
  }
  position(): BlockPosition {
    return { block_num: this.u32(), block_id: this.digest() };
  }
  optionalBytes(): Uint8Array | undefined {
    return this.optional(() => this.varbytes());
  }
}

/**
 * `finalizer_policy_with_string_key` -> the raw-key shape used everywhere else.
 *
 * `PUB_BLS_…` decodes to a compressed 48-byte point; the packed form Antelope
 * hashes is the 96-byte affine little-endian one, so it round-trips through
 * both. This is the only place that conversion is needed — a policy read out of
 * a header diff already arrives packed.
 */
function readPolicyWithStringKeys(r: ShipReader): FinalizerPolicy {
  const generation = r.u32();
  const threshold = r.u64();
  const finalizers = r.vector(() => {
    const description = r.string();
    const weight = r.u64();
    const publicKey = encodeG1ToAntelope(decodeBlsPublicKey(r.string()));
    return { description, weight, publicKey };
  });
  return { generation, threshold, finalizers };
}

export function decodeFinalityData(blob: Uint8Array): FinalityData {
  const r = new ShipReader(blob);
  const out: FinalityData = {
    major_version: r.u32(),
    minor_version: r.u32(),
    active_finalizer_policy_generation: r.u32(),
    action_mroot: r.digest(),
    reversible_blocks_mroot: r.digest(),
    latest_qc_claim_block_num: r.u32(),
    latest_qc_claim_finality_digest: r.digest(),
    latest_qc_claim_timestamp: r.u32(),
    base_digest: r.digest(),
    pending_finalizer_policy: r.optional(() => readPolicyWithStringKeys(r)),
    last_pending_finalizer_policy_generation: 0,
  };
  out.last_pending_finalizer_policy_generation = r.u32();
  if (!r.exhausted) {
    throw new Error(`finality_data: ${r.remaining} trailing bytes — layout drifted`);
  }
  return out;
}

/** get_blocks_result_v1: head, lib, this_block, prev_block, block, traces, deltas, finality_data */
export function decodeBlocksResult(data: Uint8Array): ShipBlock | undefined {
  const r = new ShipReader(data);
  r.varuint32(); // result variant
  const head = r.position();
  const last_irreversible = r.position();
  const this_block = r.optional(() => r.position());
  r.optional(() => r.position()); // prev_block
  const block = r.optionalBytes();
  const traces = r.optionalBytes();
  r.optionalBytes(); // deltas
  const fd = r.optionalBytes();
  if (!this_block) return undefined;
  return {
    head,
    last_irreversible,
    this_block,
    finality_data: fd ? decodeFinalityData(fd) : undefined,
    traces,
    block,
  };
}

/** 2000-01-01T00:00:00Z, where a `block_timestamp_type` counts half-seconds from. */
const BLOCK_EPOCH_SECONDS = 946_684_800;

/**
 * Unix seconds of a block, from its packed `signed_block`: the header's first
 * field is the slot, half-seconds since 2000. Traces carry no time of their own.
 */
export function blockTime(block: Uint8Array): number {
  return BLOCK_EPOCH_SECONDS + Math.floor(Buffer.from(block).readUInt32LE(0) / 2);
}

export function encodeAck(n: number): Buffer {
  const b = Buffer.alloc(5);
  b.writeUInt8(REQUEST_BLOCKS_ACK, 0);
  b.writeUInt32LE(n >>> 0, 1);
  return b;
}

/**
 * `irreversibleOnly` makes the node hold every block back until it is final, so
 * a follower that only appends never sees a fork. `finalityData` is off for a
 * legacy chain such as WAX, which has none to send. `fetchBlock` sends the block
 * itself, for its time.
 */
export type RequestOptions = { irreversibleOnly?: boolean; finalityData?: boolean; fetchBlock?: boolean };

export function encodeRequest(
  start: number,
  end: number,
  withTraces: boolean,
  inFlight = MESSAGES_IN_FLIGHT,
  { irreversibleOnly = false, finalityData = true, fetchBlock = false }: RequestOptions = {},
): Buffer {
  const u32 = (v: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(v >>> 0);
    return b;
  };
  return Buffer.concat([
    Buffer.from([REQUEST_BLOCKS_V1]),
    u32(start),
    u32(end),
    u32(inFlight),
    Buffer.from([0]), // have_positions
    Buffer.from([irreversibleOnly ? 1 : 0]), // irreversible_only
    Buffer.from([fetchBlock ? 1 : 0]), // fetch_block
    Buffer.from([withTraces ? 1 : 0]), // fetch_traces
    Buffer.from([0]), // fetch_deltas
    Buffer.from([finalityData ? 1 : 0]), // fetch_finality_data
  ]);
}

/**
 * Pull a contiguous run of blocks' finality data.
 *
 * One socket per call. The connection is read-only and asks for nothing but
 * finality data, which matters because this node also serves Alcor's own
 * synchronizer.
 */
export function fetchFinalityRange(
  url: string,
  from: number,
  to: number,
  timeoutMs = 60_000,
): Promise<ShipBlock[]> {
  return fetchRange(url, from, to, false, timeoutMs).then((s) => s.blocks);
}

/** The same, with action traces, and the ABI needed to decode them. */
export function fetchRange(
  url: string,
  from: number,
  to: number,
  withTraces: boolean,
  timeoutMs = 60_000,
): Promise<ShipStream> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { maxPayload: 512 * 1024 * 1024 });
    const out: ShipBlock[] = [];
    let abi = '';

    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`SHiP timeout after ${timeoutMs}ms (got ${out.length} blocks)`));
    }, timeoutMs);

    const finish = () => {
      clearTimeout(timer);
      ws.close();
      resolve({ abi, blocks: out });
    };

    ws.on('message', (data: Buffer) => {
      if (!abi) {
        abi = data.toString('utf8'); // the first message is the ABI, as JSON
        ws.send(encodeRequest(from, to + 1, withTraces));
        return;
      }
      try {
        const b = decodeBlocksResult(new Uint8Array(data));
        // Ack every result, including the empty ones the node sends past the
        // requested range; without it the stream stops after
        // MESSAGES_IN_FLIGHT and looks like a dead socket.
        ws.send(encodeAck(1));
        if (b) {
          out.push(b);
          if (b.this_block.block_num >= to) finish();
        }
      } catch (e) {
        clearTimeout(timer);
        ws.close();
        reject(e);
      }
    });

    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    ws.on('close', () => {
      clearTimeout(timer);
      resolve({ abi, blocks: out });
    });
  });
}

/**
 * What the node still holds, from its own `get_status`.
 *
 * Retention is a node setting, not a chain constant, and a request for a block
 * past it is not refused: the stream simply never answers. So anything that
 * would read old finality data asks first, rather than discovering the answer
 * as a timeout. `finalityDataBegin` is what Spring reports; a node that predates
 * the field reports its trace window instead.
 */
export type ShipStatus = {
  head: number;
  lib: number;
  traceBegin: number;
  traceEnd: number;
  finalityDataBegin?: number;
  finalityDataEnd?: number;
};

export function fetchStatus(url: string, timeoutMs = 15_000): Promise<ShipStatus> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let abi = '';
    let settled = false;
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`SHiP status timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    ws.on('message', (data: Buffer) => {
      if (!abi) {
        abi = data.toString('utf8');
        ws.send(Buffer.from([REQUEST_STATUS_V1]));
        return;
      }
      clearTimeout(timer);
      settled = true;
      ws.close();
      try {
        // Decoded by the ABI the socket sent, the way traces are: the result is a
        // variant whose fields have grown across Spring versions.
        const decoded = Serializer.decode({ data: new Uint8Array(data), type: 'result', abi: ABI.from(JSON.parse(abi)) });
        const [name, s] = JSON.parse(JSON.stringify(decoded)) as [string, any];
        if (!name.startsWith('get_status_result')) throw new Error(`expected get_status_result, got ${name}`);
        const num = (v: unknown) => (v === undefined || v === null ? undefined : Number(v));
        resolve({
          head: Number(s.head.block_num),
          lib: Number(s.last_irreversible.block_num),
          traceBegin: Number(s.trace_begin_block),
          traceEnd: Number(s.trace_end_block),
          finalityDataBegin: num(s.finality_data_begin_block),
          finalityDataEnd: num(s.finality_data_end_block),
        });
      } catch (err) {
        reject(err);
      }
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    ws.on('close', () => {
      clearTimeout(timer);
      if (!settled) reject(new Error('SHiP closed the socket without answering get_status'));
    });
  });
}

export async function fetchFinalityData(url: string, blockNum: number): Promise<ShipBlock & { finality_data: FinalityData }> {
  const [b] = await fetchFinalityRange(url, blockNum, blockNum);
  if (!b?.finality_data) throw new Error(`no finality data for block ${blockNum}`);
  return { ...b, finality_data: b.finality_data };
}
