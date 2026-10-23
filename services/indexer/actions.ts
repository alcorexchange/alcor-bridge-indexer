/**
 * Our own history of the Antelope chains: the few actions the indexer reads,
 * kept as each chain's state-history socket hands them over.
 *
 * Hyperion used to answer these questions — what a bridgeroute order said when
 * it opened and how it closed, which transaction a vault's deposit or release
 * rode in — and every answer depended on somebody else's node, its uptime and
 * the ABI it had cached (a stale one served route.alcor's `opened` with another
 * action's fields, 2026-10-20). The same actions go by on our own nodes'
 * sockets, so they are read there and stored, and nothing else is asked.
 *
 * ## What is kept
 *
 * Per chain, a short list of accounts and the action names read from each
 * (`Watch`): bridgeroute's `opened` and `closed` everywhere; the bridge's
 * `credit` and `wdlog` on Telos; the vault's `deplog`, `release` and `expire`
 * on every other chain. Only the receipt the account itself received: an inline
 * notification to a third party carries the same name and would count twice.
 *
 * ## Decoding
 *
 * An action is decoded with the ABI its contract had in that very block. The
 * ABIs are stored beside the cursor and replaced the moment the stream carries a
 * `setabi` for a watched account, so a restart picks up exactly where it left
 * off, ABIs included; only the very first start takes them from the node's head.
 * An action is kept only if it encodes back to its own bytes — a decoder that
 * stops early, which wharfkit's does, would otherwise turn an ABI mismatch into
 * plausible garbage, the exact failure that ended Hyperion here.
 *
 * ## Time
 *
 * Traces carry no time; the block's header does, and the stream sends it with
 * each block — while the node still has the block. Ours keep blocks a day and
 * traces a month, so a catch-up older than a day gets traces without headers.
 * Such a block's time is reckoned from its number, half a second per block back
 * from the head. Every slot missed since makes it later than it was: about a
 * minute a week on Telos and XPR, measured 2026-10-23. Following the chain,
 * every time is the header's.
 *
 * ## Gaps
 *
 * Only irreversible blocks are requested, so nothing stored is ever undone. The
 * stream resumes from the block after the saved one, and every block must follow
 * the one before. If the node no longer holds that block's traces — the process
 * was down longer than the node's retention (eleven days on XPR, a month on
 * Telos and WAX) — it stops and says so, on every retry, rather than skip ahead:
 * a hole in the history is for a person to fill, not for a stream to paper over.
 */

import WebSocket from 'ws';
import { ABI, Serializer } from '@wharfkit/antelope';

import { blockTime, decodeBlocksResult, encodeAck, encodeRequest, fetchStatus, type ShipBlock } from '../../src/savanna/ship.ts';
import { decodeTraces, receiptsInExecutionOrder, type ActionTrace } from '../../src/savanna/traces.ts';
import { antelopeRpc, getInfo, type RpcEndpoints } from '../../src/net/antelope.ts';
import { nameToUint64 } from '../../src/proof/pack.ts';
import type { ChainAction, Store } from './db.ts';

/** Accounts, and the actions read from each. */
export type Watch = Record<string, string[]>;

/** Where one chain's history comes from, and what it keeps. */
export type HistorySource = {
  /** The chain's registry id: `telos`, `wax`. */
  chain: string;
  /** Its state-history socket. */
  ship: string;
  /** Its HTTP API, for the contracts' ABIs on the very first start. */
  rpc: RpcEndpoints;
  /** Resolved on every start: a vault is read from the ledger's routes, so a redeployment is followed. */
  watch: () => Promise<Watch>;
  /** Called with each block's actions once they are stored. */
  onActions?: (actions: ChainAction[]) => void;
};

/** Where a chain with no cursor starts: an hour back, enough to take over from whatever read it before. */
const FIRST_LOOK_BLOCKS = 2 * 3600;
/** A quiet chain's cursor is saved this often, in blocks: a minute's worth. */
const SAVE_EVERY = 120;
const IN_FLIGHT = 100;
/** Every chain read here makes a block every half second. */
const BLOCK_SECONDS = 0.5;
const FOREVER = 0xffffffff;

/** `eosio::setabi` as the system contract declares it. */
const SETABI = ABI.from({
  version: 'eosio::abi/1.2',
  structs: [{ name: 'setabi', base: '', fields: [{ name: 'account', type: 'name' }, { name: 'abi', type: 'bytes' }] }],
  actions: [{ name: 'setabi', type: 'setabi', ricardian_contract: '' }],
});

/** The ABIs of the watched accounts, by account. */
type Abis = Map<string, ABI>;

/**
 * The watched actions in one block's traces, decoded. `abis` is updated in
 * place by any `setabi` for a watched account, in execution order, so an
 * action after it in the same block is read with the new one; `newAbis` names
 * those accounts. An action that cannot be decoded is not stored and is named
 * in `problems`.
 */
export function readActions(
  chain: string,
  traces: ActionTrace[],
  watch: Watch,
  abis: Abis,
  block: number,
  time: number,
): { actions: ChainAction[]; newAbis: string[]; problems: string[] } {
  const actions: ChainAction[] = [];
  const newAbis: string[] = [];
  const problems: string[] = [];
  for (const t of receiptsInExecutionOrder(traces)) {
    if (t.account === 'eosio' && t.receiver === 'eosio' && t.name === 'setabi') {
      const set = Serializer.decode({ data: t.data, type: 'setabi', abi: SETABI }) as any;
      const account = String(set.account);
      if (!watch[account]) continue;
      abis.set(account, Serializer.decode({ data: set.abi.array, type: ABI }) as ABI);
      newAbis.push(account);
      continue;
    }
    if (t.receiver !== t.account || !watch[t.account]?.includes(t.name)) continue;
    try {
      actions.push({
        chain,
        seq: String(t.receipt!.globalSequence),
        account: t.account,
        name: t.name,
        block_num: block,
        trx_id: t.trxId,
        time,
        data: decodeExactly(abis.get(t.account), t.name, t.data),
      });
    } catch (err) {
      problems.push(`${t.account}::${t.name} in ${t.trxId}: ${(err as Error).message}`);
    }
  }
  return { actions, newAbis, problems };
}

/** The action decoded, as JSON — only if it encodes back to exactly its bytes. */
function decodeExactly(abi: ABI | undefined, name: string, dataHex: string): Record<string, any> {
  if (!abi) throw new Error('no ABI for the account');
  const type = abi.actions.find((a) => String(a.name) === name)?.type;
  if (!type) throw new Error('the ABI declares no such action');
  const decoded = Serializer.decode({ data: dataHex, type, abi });
  if (Serializer.encode({ object: decoded, type, abi }).hexString !== dataHex.toLowerCase()) {
    throw new Error('the ABI does not describe these bytes');
  }
  return JSON.parse(JSON.stringify(decoded));
}

/** Each watched account as its packed name: a byte search over the raw traces rules most blocks out undecoded. */
function needles(watch: Watch): Buffer[] {
  return Object.keys(watch).map((account) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(nameToUint64(account));
    return b;
  });
}

export class ActionFollower {
  readonly state = {
    /** The last block read. */
    at: 0,
    lib: 0,
    /** When `at` last moved, unix seconds. */
    atMovedAt: Math.floor(Date.now() / 1000),
    lastError: null as string | null,
  };

  private readonly source: HistorySource;
  private readonly store: Store;
  private abort = new AbortController();

  constructor(source: HistorySource, store: Store) {
    this.source = source;
    this.store = store;
  }

  get chain(): string {
    return this.source.chain;
  }

  stop(): void {
    this.abort.abort();
  }

  /** Stream until stopped; throws on a lost socket or a gap, so the supervisor restarts it and records why. */
  async start(): Promise<void> {
    try {
      await this.follow();
    } catch (err) {
      this.state.lastError = (err as Error).message;
      throw err;
    }
  }

  private async follow(): Promise<void> {
    const { chain, ship } = this.source;
    this.abort = new AbortController();
    const watch = await this.source.watch();
    const status = await fetchStatus(ship);
    const saved = this.store.getNumber(this.cursorKey);
    const from = saved !== undefined ? saved + 1 : status.lib - FIRST_LOOK_BLOCKS;
    if (from < status.traceBegin) {
      throw new Error(
        `${chain}: history stops at block ${from - 1} and the node holds traces only from ${status.traceBegin}; ` +
          `fill blocks ${from}..${status.traceBegin - 1} by hand, then move the cursor (meta '${this.cursorKey}')`,
      );
    }
    const abis = await this.abisAt(watch);
    const lookFor = needles(watch);
    const head = await getInfo(this.source.rpc);
    const headTime = Math.floor(Date.parse(`${head.head_block_time}Z`) / 1000);
    // A block the node no longer has (see Time): reckoned back from the head.
    const timeOf = (b: ShipBlock): number =>
      b.block ? blockTime(b.block) : headTime - Math.ceil((head.head_block_num - b.this_block.block_num) * BLOCK_SECONDS);
    this.state.at = from - 1;
    console.log(`[history:${chain}] reading ${Object.entries(watch).map(([a, n]) => `${a}::${n.join(',')}`).join(' ')} from block ${from}`);

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(ship, { maxPayload: 512 * 1024 * 1024 });
      let shipAbi = '';
      let savedAt = from - 1;
      const onAbort = () => ws.close();
      this.abort.signal.addEventListener('abort', onAbort, { once: true });
      const fail = (err: Error) => {
        ws.close();
        reject(err);
      };

      ws.on('message', (data: Buffer) => {
        if (!shipAbi) {
          shipAbi = data.toString('utf8');
          ws.send(encodeRequest(from, FOREVER, true, IN_FLIGHT, { irreversibleOnly: true, finalityData: false, fetchBlock: true }));
          return;
        }
        try {
          const b = decodeBlocksResult(new Uint8Array(data));
          ws.send(encodeAck(1));
          if (!b) return;
          const n = b.this_block.block_num;
          if (n !== this.state.at + 1) throw new Error(`${chain}: the stream handed block ${n} after ${this.state.at}`);
          this.state.lib = b.last_irreversible.block_num;
          const found = this.read(b, shipAbi, watch, abis, lookFor, timeOf);
          this.state.at = n;
          this.state.atMovedAt = Math.floor(Date.now() / 1000);
          this.state.lastError = null;
          if (found || n - savedAt >= SAVE_EVERY) {
            this.store.setMeta(this.cursorKey, String(n));
            savedAt = n;
          }
        } catch (err) {
          fail(err as Error);
        }
      });
      ws.on('error', (err) => reject(err));
      ws.on('close', () => {
        this.abort.signal.removeEventListener('abort', onAbort);
        if (this.state.at >= from) this.store.setMeta(this.cursorKey, String(this.state.at));
        if (this.abort.signal.aborted) resolve();
        else reject(new Error(`${chain}: state-history socket closed at block ${this.state.at}`));
      });
    });
  }

  /**
   * One block: its watched actions stored and handed on, a new ABI saved.
   * Whether there was either, which has the cursor saved with them.
   */
  private read(b: ShipBlock, shipAbi: string, watch: Watch, abis: Abis, lookFor: Buffer[], timeOf: (b: ShipBlock) => number): boolean {
    if (!b.traces) return false;
    const raw = Buffer.from(b.traces);
    if (!lookFor.some((needle) => raw.indexOf(needle) >= 0)) return false;
    const n = b.this_block.block_num;
    const { actions, newAbis, problems } = readActions(this.chain, decodeTraces(shipAbi, b.traces), watch, abis, n, timeOf(b));
    for (const p of problems) this.store.incident(`history:${this.chain}`, `block ${n}: ${p}`);
    for (const account of newAbis) {
      this.saveAbi(account, abis.get(account)!);
      console.log(`[history:${this.chain}] block ${n}: new ABI for ${account}`);
    }
    if (actions.length) {
      this.store.putActions(actions);
      this.source.onActions?.(actions);
    }
    return actions.length > 0 || newAbis.length > 0;
  }

  private get cursorKey(): string {
    return `history:${this.chain}`;
  }

  private abiKey(account: string): string {
    return `history:${this.chain}:abi:${account}`;
  }

  /** Saved beside the cursor, so a restart decodes the next block with the ABI in force there. */
  private saveAbi(account: string, abi: ABI): void {
    this.store.setMeta(this.abiKey(account), JSON.stringify(abi));
  }

  /** The ABIs saved with the cursor; an account with none saved yet, from the node, and saved. */
  private async abisAt(watch: Watch): Promise<Abis> {
    const abis: Abis = new Map();
    for (const account of Object.keys(watch)) {
      const saved = this.store.getMeta(this.abiKey(account));
      if (saved) {
        abis.set(account, ABI.from(JSON.parse(saved)));
        continue;
      }
      const res = await antelopeRpc(this.source.rpc, '/v1/chain/get_abi', { account_name: account });
      if (!res?.abi) continue;
      abis.set(account, ABI.from(res.abi));
      this.saveAbi(account, abis.get(account)!);
    }
    return abis;
  }
}
