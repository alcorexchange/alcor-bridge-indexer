/**
 * The blockroot keeper of a legacy Antelope chain (WAX, XPR; src/chains/antelope.ts).
 *
 * These chains still sign blocks the legacy way:
 *
 *   sig_digest = sha256( sha256(header_digest || blockroot_merkle_root) || schedule_hash )
 *
 * where `blockroot_merkle` is the incremental merkle over the id of every
 * earlier block. It is not in any header, and Spring nodes (ours included)
 * return it empty from `get_block_header_state`, so proving one of their blocks on Telos
 * needs someone to keep it. That is this: it follows the chain's state-history from a
 * saved, verified state and serves the merkle as it stood at any later block.
 *
 * ## Why this is the only place that can be down without losing anything
 *
 * The merkle at block N is a checkpoint plus the ids between them, and ids are
 * public: our SHiP keeps a month of them, and a full-history node keeps all of
 * them. So a keeper that was down catches up by replaying; nothing it would have
 * written is gone. The one thing that could not be recomputed is the first
 * state — hence the seed, taken once and checked before it was saved: from a
 * Leap 5 node for WAX, from a node's start snapshot for XPR.
 *
 * ## Storage
 *
 *   <dir>/ids/<chunk>.bin        one 32-byte id per block, from the seed on
 *   <dir>/checkpoints/<n>.json   the merkle as of block n, every `checkpointEvery`
 *
 * Only irreversible blocks are requested, so nothing appended is ever undone.
 * That costs the chain's LIB lag behind the head, which a relayer
 * closes itself by extending the state with the reversible ids it streams.
 */
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import WebSocket from 'ws';

import { decodeBlocksResult, encodeAck, encodeRequest } from '../../src/savanna/ship.ts';
import { hex, unhex, LegacyIncrementalMerkle } from '../../src/wax/legacy.ts';
import type { LegacyChain } from '../../src/chains/antelope.ts';
import { writeJsonAtomic } from '../../src/files.ts';
import { LeafStore } from './leaves.ts';

export type KeeperConfig = {
  chain: LegacyChain;
  /** The chain's state-history socket. */
  ship: string;
  /** The verified starting state (data/<chain>-blockroot-seed.json). */
  seedFile: string;
  dir: string;
  /** Blocks between checkpoints; the most a lookup ever replays. */
  checkpointEvery: number;
};

/** The merkle as it stands at `block_num`: over the ids of blocks 1 .. block_num - 1. */
export type BlockrootState = { block_num: number; node_count: number; active_nodes: string[]; root: string };

const IN_FLIGHT = 1000;
const FOREVER = 0xffffffff;

function readState(path: string): { block_num: number; node_count: number; active_nodes: string[] } {
  const s = JSON.parse(readFileSync(path, 'utf8'));
  if (s.node_count !== s.block_num - 1) {
    throw new Error(`${path}: node_count ${s.node_count} does not describe block ${s.block_num}`);
  }
  return s;
}

export class BlockrootKeeper {
  readonly state = {
    status: 'starting' as 'starting' | 'catching-up' | 'following' | 'stopped',
    /** The last block whose id is stored. */
    committed: 0,
    head: 0,
    lib: 0,
  };

  private readonly cfg: KeeperConfig;
  private readonly seed: ReturnType<typeof readState>;
  private readonly ids: LeafStore;
  private readonly checkpointDir: string;
  /** Checkpoint block numbers, ascending. */
  private checkpoints: number[] = [];
  private merkle: LegacyIncrementalMerkle | undefined;
  private abort = new AbortController();

  constructor(cfg: KeeperConfig) {
    this.cfg = cfg;
    this.seed = readState(cfg.seedFile);
    this.ids = new LeafStore(join(cfg.dir, 'ids'), this.seed.block_num);
    this.checkpointDir = join(cfg.dir, 'checkpoints');
    mkdirSync(this.checkpointDir, { recursive: true });
    this.checkpoints = readdirSync(this.checkpointDir)
      .map((n) => /^(\d+)\.json$/.exec(n))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => Number(m[1]))
      .sort((a, b) => a - b);
  }

  /** Stream until stopped; throws on a lost socket so the supervisor restarts it. */
  start(): Promise<void> {
    this.abort = new AbortController();
    this.merkle = this.resume();
    const from = this.merkle.count + 1;
    this.state.committed = this.merkle.count;
    this.state.status = 'catching-up';
    console.log(`[${this.cfg.chain.id}] merkle at ${this.merkle.count} ids; streaming irreversible blocks from ${from}`);

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.cfg.ship, { maxPayload: 64 * 1024 * 1024 });
      let abiSeen = false;
      const onAbort = () => ws.close();
      this.abort.signal.addEventListener('abort', onAbort, { once: true });

      ws.on('message', (data: Buffer) => {
        if (!abiSeen) {
          abiSeen = true;
          ws.send(encodeRequest(from, FOREVER, false, IN_FLIGHT, { irreversibleOnly: true, finalityData: false }));
          return;
        }
        try {
          const r = decodeBlocksResult(new Uint8Array(data));
          ws.send(encodeAck(1));
          if (!r) return;
          this.state.head = r.head.block_num;
          this.state.lib = r.last_irreversible.block_num;
          this.append(r.this_block.block_num, r.this_block.block_id);
        } catch (err) {
          ws.close();
          reject(err);
        }
      });
      ws.on('error', (err) => reject(err));
      ws.on('close', () => {
        this.abort.signal.removeEventListener('abort', onAbort);
        if (this.abort.signal.aborted) {
          this.state.status = 'stopped';
          resolve();
        } else {
          reject(new Error(`${this.cfg.chain.name} state-history socket closed at ${this.state.committed}`));
        }
      });
    });
  }

  stop(): void {
    this.abort.abort();
  }

  /**
   * The merkle as it stood at `block`. Replays at most `checkpointEvery` ids
   * from the nearest checkpoint, so it is hashing, not networking.
   */
  stateAt(block: number): BlockrootState {
    const newest = this.state.committed + 1;
    if (block < this.seed.block_num || block > newest) {
      throw new Error(`block ${block} is outside ${this.seed.block_num}..${newest}, the range this keeper holds`);
    }
    const from = this.checkpoints.filter((c) => c <= block).pop();
    const start = from !== undefined ? readState(join(this.checkpointDir, `${from}.json`)) : this.seed;
    const merkle = new LegacyIncrementalMerkle(start.active_nodes.map(unhex), start.node_count);
    for (let n = start.block_num; n < block; n++) merkle.append(this.id(n));
    return { block_num: block, node_count: merkle.count, active_nodes: merkle.nodes.map(hex), root: hex(merkle.root()) };
  }

  snapshot() {
    return { ...this.state, seed: this.seed.block_num, checkpoints: this.checkpoints.length };
  }

  private id(block: number): Uint8Array {
    const id = this.ids.read(block);
    if (!id) throw new Error(`no stored id for ${this.cfg.chain.name} block ${block}`);
    return id;
  }

  /** The newest checkpoint, then every id stored after it. */
  private resume(): LegacyIncrementalMerkle {
    const last = this.checkpoints[this.checkpoints.length - 1];
    const start = last !== undefined ? readState(join(this.checkpointDir, `${last}.json`)) : this.seed;
    const merkle = new LegacyIncrementalMerkle(start.active_nodes.map(unhex), start.node_count);
    const stored = this.ids.lastBlock;
    if (stored !== undefined) {
      for (let n = start.block_num; n <= stored; n++) merkle.append(this.id(n));
    }
    return merkle;
  }

  private append(block: number, idHex: string): void {
    const merkle = this.merkle!;
    if (block !== merkle.count + 1) {
      throw new Error(`${this.cfg.chain.name} stream handed block ${block}, the merkle expects ${merkle.count + 1}`);
    }
    const id = unhex(idHex);
    // A block id carries its own number in its first four bytes.
    if (((id[0] << 24) | (id[1] << 16) | (id[2] << 8) | id[3]) >>> 0 !== block) {
      throw new Error(`${this.cfg.chain.name} block ${block} has id ${idHex}, which names a different block`);
    }
    this.ids.append(block, id);
    merkle.append(id);
    this.state.committed = block;
    if (this.state.lib - block < 10) this.state.status = 'following';

    const next = block + 1;
    const lastCheckpoint = this.checkpoints[this.checkpoints.length - 1] ?? this.seed.block_num;
    if (next - lastCheckpoint >= this.cfg.checkpointEvery) {
      writeJsonAtomic(join(this.checkpointDir, `${next}.json`), {
        block_num: next,
        node_count: merkle.count,
        active_nodes: merkle.nodes.map(hex),
      });
      this.checkpoints.push(next);
    }
  }
}
