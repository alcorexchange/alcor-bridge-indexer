/**
 * Following the settlement chain: the tree at the head, and an artifact the
 * moment a withdrawal is burned.
 *
 * ## The one job with a clock on it
 *
 * A withdrawal proof has two halves and they are kept for very different spans.
 * Action traces live about a month on this node; `finality_data` about eight
 * days — and `submitRoot` needs the full finality data of the block that carries
 * the root. So a burn that is not turned into an artifact inside that window can
 * no longer be proved from live data, whatever the tree says. Freezing costs two
 * kilobytes and happens about a second after the burn, because the certificate
 * that signs the root arrives two blocks later.
 *
 * ## Why the tree and the freezer are one process
 *
 * A branch is made of interior nodes, and those exist only inside a tree that
 * appended the leaves under them. A separate freezer would have to replay the
 * chain to rebuild them — which is exactly the nine-minute wait this exists to
 * remove. Standing on the head, the branch is already in hand.
 *
 * ## Restart
 *
 * The frontier is written every few seconds, the leaves on every block, so after
 * a crash the leaf file is ahead of the frontier. That is the recovery log: the
 * tree is replayed forward over the stored leaves until the two agree, and the
 * stream resumes from there. Nothing is refetched and nothing is lost.
 */

import { existsSync } from 'node:fs';

import type { IndexerConfig } from './config.ts';
import { leafWindowBlocks } from './config.ts';
import { Store, withdrawalKey, depositKey, externalToken } from './db.ts';
import { LeafStore, alignLeaves } from './leaves.ts';
import { treeThrough } from './tree.ts';
import { antelopeBurns, bridgeAbi, readBridgeEvents } from './bridgeActions.ts';
import { applyBridgeEvents } from './ledgerEvents.ts';

import { buildTree, headerRootFor, headerSlot } from '../../src/savanna/treeBuilder.ts';
import { PolicyTracker } from '../../src/savanna/finality.ts';
import {
  readFrontier,
  writeFrontier,
  frontierOf,
  saveCheckpoint,
  newestCheckpointAtOrBefore,
} from '../../src/savanna/frontier.ts';
import { fetchFinalityRange, fetchRange, type ShipBlock } from '../../src/savanna/ship.ts';
import { decodeTraces, type ActionTrace } from '../../src/savanna/traces.ts';
import { BeforeRetention, findPolicyPublication } from '../../src/savanna/policyChain.ts';
import { assembleHandover } from '../../src/savanna/handover.ts';
import {
  assembleWithdrawalArtifact,
  artifactToJson,
  locateRootBlocks,
  type WithdrawalArtifact,
} from '../../src/savanna/withdrawalArtifact.ts';
import { blockWdlogs, type BlockWdlog } from '../../src/savanna/withdrawalProof.ts';
import {
  decodePolicy,
  encodePolicy,
  type FinalizerPolicy,
} from '../../src/savanna/policyDiff.ts';
import type { IncrementalTree } from '../../src/proof/merkle.ts';
import { antelopeRpc, getBlock, getTableRows } from '../../src/net/antelope.ts';
import { antelopeVaults } from '../../src/chains/antelope.ts';
import { hexToName, nameToUint64, slotToUnix } from '../../src/proof/pack.ts';
import { toHex } from '../../src/proof/hex.ts';

/** Blocks of stream kept around, for the window an artifact needs. */
const RECENT_BLOCKS = 64;
/** Give up freezing from the live stream after this many blocks go by. */
const FREEZE_PATIENCE = 30;
/** How often the frontier is written. Leaves are written every block regardless. */
const FRONTIER_EVERY_MS = 15_000;
/**
 * Blocks to wait after a policy is published before building its handover:
 * the certificate that claims it rides a few blocks later, and the handover
 * reads a window of eight past it.
 */
/** Whether a stored handover's certificate makes its policy final: its claim reaches P. */
function settlesPolicy(h: { submitRoot: { finality: { qcClaimTimestamp: number; lastPendingPolicyStart: number } } }): boolean {
  return h.submitRoot.finality.qcClaimTimestamp >= h.submitRoot.finality.lastPendingPolicyStart;
}

const HANDOVER_DELAY = 12;

type Pending = {
  burn: number;
  /** The block's EVM-bound `wdlog`s, each with its ordinal among all of them. */
  wdlogs: BlockWdlog[];
  traces: ActionTrace[];
  rootAtBurn?: string;
  firstSeen: number;
};

export type SettlementState = {
  at: number;
  head: number;
  leaves: number;
  caughtUp: boolean;
  appended: number;
  mismatches: number;
  windowFrom: number | undefined;
  windowBlocks: number;
  frozen: number;
  lastError: string | null;
};

export class SettlementFollower {
  private cfg: IndexerConfig;
  private store: Store;
  private leaves: LeafStore;
  private tracker = new PolicyTracker();
  private recent = new Map<number, ShipBlock>();
  private pending = new Map<number, Pending>();
  private abort = new AbortController();
  private needle: Buffer;
  private lastFrontierWrite = 0;
  private sinceForget = 0;
  private windowBlocks: number;
  /** The bridge contract's ABI, for decoding its own actions out of the stream. */
  private abiOfBridge: import('@wharfkit/antelope').ABI | undefined;
  private leafTotal = 0;
  private tree!: IncrementalTree;
  /** Generations published on the stream whose handover is not built yet, by block. */
  private handoversDue = new Map<number, number>();
  /** Handovers that failed to build once; retried only by a restart. */
  private handoversFailed = new Set<number>();

  readonly state: SettlementState = {
    at: 0, head: 0, leaves: 0, caughtUp: false, appended: 0, mismatches: 0,
    windowFrom: undefined, windowBlocks: 0, frozen: 0, lastError: null,
  };

  constructor(cfg: IndexerConfig, store: Store) {
    this.cfg = cfg;
    this.store = store;

    const genesis = cfg.savanna.finalityGenesisBlock;
    if (!genesis) {
      throw new Error(
        `chain '${cfg.savanna.id}' has no finalityGenesisBlock in the registry, so a leaf's ` +
          `index is unknown and no branch can be placed`,
      );
    }
    this.leaves = new LeafStore(cfg.leavesDir, genesis);
    this.windowBlocks = leafWindowBlocks(cfg, 0);

    // A cheap pre-filter: the bridge account appears in a trace as a packed
    // uint64, so a byte search over the raw blob rules out most blocks without
    // decoding anything. At the head that is a nicety; catching up at seven
    // hundred blocks a second it is the difference.
    const packed = nameToUint64(cfg.savanna.accounts.bridge);
    this.needle = Buffer.alloc(8);
    this.needle.writeBigUInt64LE(packed);
  }

  get leafStore(): LeafStore {
    return this.leaves;
  }

  stop(): void {
    this.abort.abort();
  }

  /** Runs until `stop()`. Resolves; it does not reject on a dropped socket. */
  async start(): Promise<void> {
    const { cfg } = this;
    const source = existsSync(cfg.stateFile) ? cfg.stateFile : cfg.seedFile;
    const { frontier, tree } = readFrontier(source);
    this.tree = tree;
    this.tracker.restore(frontier.policies ?? []);
    this.state.mismatches = frontier.mismatches ?? 0;

    let at = frontier.last_block;
    let leafCount = frontier.leaves;

    // A window that cannot continue the frontier is dropped rather than carried.
    // Loud, because it costs the cheap track.
    const reset = alignLeaves(this.leaves, at);
    if (reset) {
      this.store.incident(
        'leaf-window-reset',
        `leaves ${reset.window} do not continue the frontier at ${at}; dropped ${reset.dropped} ` +
          `leaves rather than leave a gap`,
      );
      console.log(`[savanna] leaf window reset (${reset.dropped} leaves dropped)`);
    }

    // The leaf file is the recovery log: it is written per block, the frontier
    // every few seconds, so after a crash the leaves are ahead. Walk the tree
    // forward over them rather than refetching.
    const storedLast = this.leaves.lastBlock;
    if (storedLast !== undefined && storedLast > at) {
      const replay = this.leaves.readRange(at + 1, storedLast);
      for (const leaf of replay) tree.append(leaf);
      leafCount += replay.length;
      at = storedLast;
      console.log(`[savanna] replayed ${replay.length} stored leaves to block ${at}`);
    }

    this.leafTotal = leafCount;
    this.state.at = at;
    this.state.leaves = leafCount;
    console.log(`[savanna] resuming from ${source}: block ${at}, ${leafCount} leaves`);

    // Without it the stream still yields withdrawals — the `wdlog` scan below
    // needs no ABI — but credits, refunds and claims go unread until the next
    // reconciliation, which is a minute rather than half a second.
    try {
      this.abiOfBridge = await bridgeAbi(cfg.savanna);
    } catch (err) {
      this.store.incident('bridge-abi', (err as Error).message);
      console.log(`[savanna] could not read the bridge ABI: ${(err as Error).message}`);
    }

    const seedRoot = toHex(tree.root());

    try {
      await buildTree({
        chain: cfg.savanna,
        ship: cfg.ship,
        tree,
        seedBlock: at,
        seedRoot,
        follow: true,
        signal: this.abort.signal,
        fetchTraces: true,
        // A checkpoint carries the policies, so there is nothing to warm up.
        warmup: frontier.policies?.length ? 0 : 100_000,
        tracker: this.tracker,
        slotFromHeader: (n) => headerSlot(cfg.savanna, n),
        onBlock: (block, abi) => this.onBlock(block, abi),
        onPolicy: (policy, block) => this.onPolicy(policy, block),
        onLeaf: (n, leaf, rootAfter) => this.onLeaf(n, leaf, rootAfter),
        // Every root computed is an assertion a producer signed. Checking one
        // now and then makes a divergence surface here, named and with a block
        // number, instead of as a proof the far chain silently refuses.
        verifyEvery: cfg.verifyEvery,
        onVerify: (n, root) => this.verifyRoot(n, root),
        onCaughtUp: (n) => {
          this.state.caughtUp = true;
          console.log(`[savanna] caught up at ${n}`);
        },
        onRecoveredActionRoot: (n, root) =>
          console.log(
            `[savanna] block ${n}: state-history reported an all-zero action_mroot; ` +
              `rebuilt ${root.slice(0, 16)}… from its traces`,
          ),
        onProgress: (s) => {
          this.state.head = s.head;
          console.log(
            `[savanna] ${s.at} of ${s.head} (${s.head - s.at} behind), ` +
              `${s.appended.toLocaleString('en-US')} appended`,
          );
        },
      });
    } catch (err) {
      this.state.lastError = (err as Error).message;
      this.store.incident('savanna-stream', (err as Error).message);
      throw err;
    } finally {
      this.saveFrontier(this.state.at);
    }
  }

  // --- stream callbacks ----------------------------------------------------------

  private onBlock(block: ShipBlock, abi: string): void {
    const n = block.this_block.block_num;
    this.state.head = block.head.block_num;

    this.recent.set(n, block);
    for (const key of this.recent.keys()) {
      if (key < n - RECENT_BLOCKS) this.recent.delete(key);
    }

    if (!block.traces || Buffer.from(block.traces).indexOf(this.needle) < 0) return;

    let traces: ActionTrace[];
    try {
      traces = decodeTraces(abi, block.traces);
    } catch (err) {
      this.store.incident('trace-decode', `block ${n}: ${(err as Error).message}`);
      return;
    }

    // Every step a crossing takes on this chain, with the transaction it rode
    // in. The tables know what happened; only the stream knows where to look it
    // up, and that is what a person is shown.
    const at = slotToUnix(this.cfg.savanna, block.finality_data!.latest_qc_claim_timestamp);
    const wdlogs = blockWdlogs(traces, this.cfg.savanna.accounts.bridge);
    const events = this.abiOfBridge
      ? readBridgeEvents(this.abiOfBridge, this.cfg.savanna.accounts.bridge, traces, this.cfg.savanna.accounts.hop)
      : [];
    // A burn bound for an Antelope chain is recorded the moment it happens; the
    // relayer of that chain proves it, so only the EVM ones are frozen here.
    try {
      applyBridgeEvents(this.store, [...antelopeBurns(wdlogs), ...events], n, at);
    } catch (err) {
      // The rows are the fast path; reconciliation writes them again from the
      // tables. The freeze below is the part with a clock on it, so it goes on.
      this.store.incident('ledger-events', `block ${n}: ${(err as Error).message}`);
    }
    for (const e of events) {
      if (e.kind === 'credit' && !e.memo) void this.markIfParked(e.domain, e.nonce);
    }

    const frozen = wdlogs.filter((w) => w.frozen);
    if (!frozen.length) return;
    console.log(`[savanna] block ${n}: ${frozen.length} wdlog(s)`);
    this.pending.set(n, { burn: n, wdlogs: frozen, traces, firstSeen: n });
  }

  private onPolicy(policy: FinalizerPolicy, block: number): void {
    this.store.putPolicy(policy.generation, block, encodePolicy(policy));
    this.handoversDue.set(policy.generation, block);
    console.log(`[savanna] policy generation ${policy.generation} published in block ${block}`);
  }

  private onLeaf(n: number, leaf: Uint8Array, rootAfter: string): void {
    this.leaves.append(n, leaf);
    this.leafTotal++;
    this.state.at = n;
    this.state.appended++;
    this.state.leaves = this.leafTotal;
    this.state.windowFrom = this.leaves.firstBlock;
    this.state.windowBlocks = this.leaves.count;

    const waiting = this.pending.get(n);
    if (waiting) waiting.rootAtBurn = rootAfter;

    if (this.leafTotal % this.cfg.checkpointEvery === 0) {
      saveCheckpoint(
        this.cfg.checkpointDir,
        frontierOf(this.tree, n, this.leafTotal, this.tracker.snapshot()),
      );
      console.log(`[savanna] checkpoint at ${n}`);
    }

    if (Date.now() - this.lastFrontierWrite > FRONTIER_EVERY_MS) this.saveFrontier(n);

    if (this.pending.size) void this.tryFreeze(n);
    if (this.handoversDue.size) void this.tryHandovers(n);

    // Bound the interior-node map. Nothing older than a block or two is ever
    // asked for a branch, and a pending freeze is always younger than this.
    if (++this.sinceForget >= this.cfg.forgetEvery && !this.pending.size) {
      this.sinceForget = 0;
      this.tree.forget();
    }
  }

  /**
   * Compare one computed root with the header that claims it.
   *
   * A block whose certificate claims another block carries that block's tree
   * root in its `action_mroot` — the header field of that name was repurposed
   * under Savanna. If the block at hand claims something else, there is nothing
   * to compare and the check is skipped rather than guessed at.
   *
   * A mismatch is recorded, not thrown: stopping the stream would also stop the
   * API that has to report it, and the frontier carries the count so a restart
   * cannot resume into a tree the chain disagrees with.
   */
  private async verifyRoot(atBlock: number, root: string): Promise<void> {
    try {
      const recorded = await headerRootFor(this.cfg.savanna, atBlock);
      if (recorded === undefined) return;
      if (recorded === root) {
        console.log(`[savanna] root at ${atBlock} matches the chain`);
        return;
      }
      this.state.mismatches++;
      const detail =
        `root at ${atBlock} is ${root}, the chain says ${recorded} — every root ` +
        `after this one inherits the divergence`;
      this.store.incident('root-mismatch', detail);
      console.log(`[savanna] MISMATCH: ${detail}`);
    } catch (err) {
      // A node that will not answer is not a mismatch. Say so and move on.
      this.store.incident('root-check', `block ${atBlock + 1}: ${(err as Error).message}`);
    }
  }

  private saveFrontier(at: number): void {
    this.lastFrontierWrite = Date.now();
    writeFrontier(this.cfg.stateFile, {
      ...frontierOf(this.tree, at, this.leafTotal, this.tracker.snapshot()),
      mismatches: this.state.mismatches,
    });
  }

  // --- policy handovers ------------------------------------------------------------

  private buildingHandovers = false;

  private async tryHandovers(now: number): Promise<void> {
    if (this.buildingHandovers) return;
    this.buildingHandovers = true;
    try {
      for (const [generation, block] of [...this.handoversDue]) {
        if (now < block + HANDOVER_DELAY) continue;
        this.handoversDue.delete(generation);
        await this.freezeHandover(generation, block);
      }
    } finally {
      this.buildingHandovers = false;
    }
  }

  /**
   * Build and store the certificate that hands `generation` over, checked locally.
   *
   * An EVM light client follows Telos one generation at a time, and each step
   * needs the certificate from the two-block window where that generation was
   * pending. State-history keeps it about a day; a client left behind longer
   * than that can only catch up from what is stored here.
   */
  private async freezeHandover(generation: number, block: number): Promise<boolean> {
    // One stored before 2026-10-20 may be the certificate over P itself, whose
    // claim does not reach P: the policy it names is not final there, and the
    // light clients now record nothing from it (ETH-Telos audit B-03). Built
    // again while state-history still holds the window; kept as it is if not.
    const existing = this.store.getHandover(generation);
    if (existing && settlesPolicy(JSON.parse(existing.body))) return true;
    const stored = this.store.getPolicy(generation);
    if (!stored) return false;
    try {
      const h = await assembleHandover(this.cfg.savanna, this.cfg.ship, block, decodePolicy(stored.body), (g) =>
        this.policyFor(g, block),
      );
      if (!h.check.ok) throw new Error(`certificate in block ${h.carrierBlock} refused: ${h.check.reason}`);
      const body = JSON.stringify({
        generation,
        block,
        transitionBlock: h.transition,
        carrierBlock: h.carrierBlock,
        previousGeneration: h.previous.generation,
        submitRoot: h.args,
      });
      if (existing) this.store.replaceHandover(generation, block, body);
      else this.store.putHandover(generation, block, body);
      console.log(`[savanna] handover to generation ${generation} ${existing ? 'rebuilt' : 'stored'} (block ${block}, certified ${h.transition})`);
      return true;
    } catch (err) {
      this.handoversFailed.add(generation);
      // An old one past state-history stays as it was: nothing to report again.
      if (existing) return true;
      // The generation it hands over FROM was published before what state-history
      // holds: permanent, and nothing here can change it. Said once, not filed.
      if (err instanceof BeforeRetention) {
        console.log(`[savanna] handover to generation ${generation} cannot be built: ${err.message}`);
        return false;
      }
      this.store.incident('handover', `generation ${generation} at block ${block}: ${(err as Error).message}`);
      console.log(`[savanna] handover to generation ${generation} failed: ${(err as Error).message}`);
      return false;
    }
  }

  /** Every published generation without a stored handover, tried once per process. */
  private async freezeMissingHandovers(): Promise<void> {
    for (const { generation, block } of this.store.listPolicies()) {
      if (this.handoversDue.has(generation) || this.handoversFailed.has(generation)) continue;
      if (block + HANDOVER_DELAY > this.state.at) continue;
      await this.freezeHandover(generation, block);
    }
  }

  // --- freezing -------------------------------------------------------------------

  private freezing = false;

  private async tryFreeze(now: number): Promise<void> {
    if (this.freezing) return;
    this.freezing = true;
    try {
      for (const [burn, p] of [...this.pending]) {
        if (p.rootAtBurn === undefined) continue;

        const window = [...this.recent.values()].filter(
          (b) => b.this_block.block_num >= burn - 1 && b.this_block.block_num <= burn + 12,
        );
        try {
          locateRootBlocks(window, burn); // not yet signed? throws, and we wait
        } catch {
          if (now - p.firstSeen > FREEZE_PATIENCE) {
            this.pending.delete(burn);
            this.store.incident(
              'freeze-timeout',
              `no certificate chain for burn ${burn} within ${FREEZE_PATIENCE} blocks`,
            );
          }
          continue;
        }

        this.pending.delete(burn);
        await this.freeze(burn, p, window);
      }
    } finally {
      this.freezing = false;
    }
  }

  private async freeze(burn: number, p: Pending, window: ShipBlock[]): Promise<void> {
    // Who burned it. `wdlog` carries the recipient on the far chain and not the
    // owner here — it is a payload for a foreign verifier, not a record for this
    // one — so the owner comes from the contract's own table. Without it the row
    // exists with no account, and a page filtered by account cannot see a
    // withdrawal until the next reconciliation pass a minute later.
    const owners = await this.ownersOfWithdrawals();

    for (const w of p.wdlogs) {
      try {
        const artifact = await this.artifactFor(w, { burn, window, traces: p.traces, tree: this.tree, rootAtBurn: p.rootAtBurn! });
        this.record(artifact, burn, w.trxId, owners.get(Number(w.id)));
      } catch (err) {
        this.store.incident(
          'freeze-failed',
          `burn ${burn} wdlog #${w.ordinal}: ${(err as Error).message}`,
        );
        console.log(`[savanna] FREEZE FAILED burn ${burn} #${w.ordinal}: ${(err as Error).message}`);
      }
    }
  }

  /**
   * The artifact for one `wdlog` of a burn block, with everything that is the
   * same for every withdrawal this follower freezes filled in.
   */
  private artifactFor(
    w: BlockWdlog,
    at: { burn: number; window: ShipBlock[]; traces: ActionTrace[]; tree: IncrementalTree; rootAtBurn: string },
  ): Promise<WithdrawalArtifact> {
    return assembleWithdrawalArtifact({
      chain: this.cfg.savanna,
      bridgeAccount: this.cfg.savanna.accounts.bridge,
      ...at,
      tracker: this.tracker,
      policyFor: (g, block) => this.policyFor(g, block),
      rawBlock: (n) => antelopeRpc(this.cfg.savanna, '/v1/chain/get_raw_block', { block_num_or_id: n }),
      wdlogOrdinal: w.ordinal,
    });
  }

  /** Withdrawal id to the account that burned it, from the bridge's own table. */
  private async ownersOfWithdrawals(): Promise<Map<number, string>> {
    try {
      const rows = await getTableRows<{ id: number | string; owner: string }>(this.cfg.savanna, {
        code: this.cfg.savanna.accounts.bridge,
        table: 'wdraws',
      });
      return new Map(rows.map((r) => [Number(r.id), String(r.owner)]));
    } catch (err) {
      // A missing owner delays a filtered view by one reconciliation pass; it
      // does not delay the proof, which is the part with a clock on it.
      this.store.incident('owner-lookup', (err as Error).message);
      return new Map();
    }
  }

  private record(artifact: WithdrawalArtifact, burn: number, srcTx: string, owner?: string): void {
    const r = artifact.release;
    const key = withdrawalKey(r.id.toString());
    const body = artifactToJson(artifact);
    // The burn's own time, from the leaf's slot — not the clock. Reconciliation
    // would correct it from the table later, but a history that reads "just now"
    // for an hour is a history somebody screenshots.
    const burnedAt = slotToUnix(this.cfg.savanna, r.timestamp);
    this.store.putProof(key, 'withdrawal', body);
    this.store.upsertTransfer({
      key,
      direction: 'withdrawal',
      ref: Number(r.id),
      status: 'provable',
      account: owner ?? null,
      evm_address: r.recipient.toLowerCase(),
      token: r.token.toLowerCase(),
      amount: r.amount.toString(),
      domain: String(r.domain),
      src_block: burn,
      src_time: burnedAt,
      src_tx: srcTx,
      deadline: Number(r.deadline),
      proof_at: Math.floor(Date.now() / 1000),
    });
    this.state.frozen++;
    console.log(
      `[savanna] froze withdrawal ${r.id} from block ${burn} (${body.length} bytes), ` +
        `root block ${artifact.rootBlock}`,
    );
  }

  /**
   * The full policy for a generation.
   *
   * From the stream when this process saw it published, which is the steady
   * state; otherwise by binary search over state-history, which is what a first
   * run or a long restart needs and which only works inside retention.
   */
  private async policyFor(generation: number, atBlock: number): Promise<FinalizerPolicy> {
    const stored = this.store.getPolicy(generation);
    if (stored) return decodePolicy(stored.body);

    const found = await findPolicyPublication(this.cfg.ship, atBlock, generation);
    this.store.putPolicy(generation, found.block, encodePolicy(found.policy));
    return found.policy;
  }

  // --- reconciliation ---------------------------------------------------------------

  /** Move a booked deposit to `parked`, keeping whatever else is known of it. */
  private markParked(domain: string, nonce: number): void {
    this.store.upsertTransfer({
      key: depositKey(domain, nonce),
      direction: 'deposit',
      ref: nonce,
      status: 'parked',
      firstSeen: { block: 0, time: Math.floor(Date.now() / 1000) },
    });
  }

  /**
   * Whether a credit without a memo was parked — for an account that does not
   * exist yet — asked of the table the bridge keeps.
   *
   * After the fact, so a row already forwarded reads as absent; that is
   * harmless, because the `forward` action then moves the status past this.
   */
  private async markIfParked(domain: string, nonce: number): Promise<void> {
    try {
      const [row] = await getTableRows<{ nonce: number | string }>(this.cfg.savanna, {
        code: this.cfg.savanna.accounts.bridge,
        scope: String(domain),
        table: 'parked',
        lower_bound: nonce,
        limit: 1,
      });
      if (row && Number(row.nonce) === nonce) this.markParked(domain, nonce);
    } catch (err) {
      console.log(`[savanna] could not tell whether deposit #${nonce} on ${domain} was parked: ${(err as Error).message}`);
    }
  }

  /**
   * The withdrawal ids each Antelope vault has settled, from its `settled`
   * bitmap (64 ids to a row), read on the vault's own chain. Only for a chain
   * this instance follows; for any other nothing is read and no status is claimed.
   */
  private async settledOnAntelope(vaults: Map<string, string>): Promise<Map<string, Set<number>>> {
    const out = new Map<string, Set<number>>();
    for (const [domain, vault] of vaults) {
      const rpc = this.cfg.antelope.find((a) => a.chain.domain === domain)?.rpc;
      if (!rpc) continue;
      try {
        const rows = await getTableRows<{ word: number | string; bits: number | string }>(
          { rpc: [rpc] },
          { code: vault, table: 'settled' },
        );
        const ids = new Set<number>();
        for (const r of rows) {
          const bits = BigInt(r.bits);
          for (let i = 0; i < 64; i++) if ((bits >> BigInt(i)) & 1n) ids.add(Number(r.word) * 64 + i);
        }
        out.set(domain, ids);
      } catch (err) {
        console.log(`[reconcile] could not read what ${vault} settled: ${(err as Error).message}`);
      }
    }
    return out;
  }

  /**
   * Bring stored state back in line with the chain's own tables.
   *
   * The stream is the fast path and the tables are the authority. Anything the
   * stream missed — because this process was down, or because the burn predates
   * it — is found here, and any burn still without an artifact is frozen by
   * replaying locally from the leaf window.
   */
  async reconcile(): Promise<{ withdrawals: number; deposits: number; froze: number }> {
    const chain = this.cfg.savanna;
    const bridge = chain.accounts.bridge;

    const routes = await getTableRows<{
      id: number | string;
      domain: number | string;
      vault: string;
      ext_token: string;
      withdraw_ttl: number | string;
    }>(chain, { code: bridge, table: 'routes' });
    // The Antelope routes: a domain to the vault that pays it, an account name
    // packed to eight bytes. What the vault settled is read from the vault
    // itself, the way an EVM release is read from the EVM chain.
    const vaults = new Map([...antelopeVaults(routes)].map(([domain, v]) => [domain, v.account]));
    const antelopeSettled = await this.settledOnAntelope(vaults);
    // `wdraws` records the route, not the token. Without resolving it here the
    // row has no external address, and everything downstream that reads units
    // from the listing — the symbol, the precision an amount is denominated in —
    // has nothing to look them up by.
    const tokenOfRoute = new Map(
      routes.map((r) => [Number(r.id), externalToken(String(r.domain), String(r.ext_token))]),
    );
    // Non-finite values are skipped, not folded in: one `Math.max` over NaN makes
    // the whole reduction NaN, and that NaN flowed into `pruneWindow` as a
    // deletion boundary once already and removed a million leaves.
    const longestTtl = routes.reduce((m, r) => {
      const ttl = Number(r.withdraw_ttl);
      return Number.isFinite(ttl) ? Math.max(m, ttl) : m;
    }, 0);
    this.windowBlocks = leafWindowBlocks(this.cfg, longestTtl);

    const wdraws = await getTableRows<{
      id: number | string;
      owner: string;
      route_id: number | string;
      amount: number | string;
      domain: number | string;
      recipient: string;
      deadline: number | string;
      status: number;
      block_num: number;
      at: string;
    }>(chain, { code: bridge, table: 'wdraws' });

    let froze = 0;
    const now = Math.floor(Date.now() / 1000);
    for (const w of wdraws) {
      const key = withdrawalKey(String(w.id));
      const hasProof = this.store.hasProof(key);
      const antelope = vaults.has(String(w.domain));
      // An Antelope vault settles an id on release and on expiry alike, and only
      // Telos learns which by the refund that follows. A release is impossible
      // after the deadline, so a settled id inside it was paid; one past it
      // stays `burned` until the refund lands and the ledger says `refunded`.
      const paidThere = antelope && (antelopeSettled.get(String(w.domain))?.has(Number(w.id)) ?? false) && now <= Number(w.deadline);
      const status =
        Number(w.status) === 2 ? 'refunded'
        : Number(w.status) === 1 || paidThere ? 'released'
        : hasProof ? 'provable' : 'burned';

      this.store.upsertTransfer({
        key,
        direction: 'withdrawal',
        ref: Number(w.id),
        status,
        account: w.owner,
        // The far-side address: hex for an EVM chain, an account name on an Antelope one.
        evm_address: antelope ? hexToName(String(w.recipient)) : `0x${w.recipient}`.toLowerCase(),
        token: tokenOfRoute.get(Number(w.route_id)) ?? null,
        amount: String(w.amount),
        domain: String(w.domain),
        src_block: Number(w.block_num),
        src_time: Math.floor(Date.parse(`${w.at}Z`) / 1000),
        deadline: Number(w.deadline),
      });

      if (!antelope && !hasProof && Number(w.status) === 0) {
        if (await this.freezeByReplay(Number(w.block_num), Number(w.id))) froze++;
      }
    }

    // Scoped by DOMAIN, not by the contract. `seen_table seen(get_self(), domain)`
    // — and a table read with the wrong scope is not an error, it is an empty
    // answer. Read as `ethbridge111` this returned nothing forever, so nothing
    // was ever marked credited: the queue kept offering work that was done, and
    // a deposit proved a day earlier still looked like it was waiting.
    let credited = 0;

    // Every route's scope, not just this instance's own chain. Reading one and
    // keying the rows without a domain is what made a BSC deposit and a Sepolia
    // deposit share a row.
    const domains = [...this.cfg.sources.map((s) => String(s.chain.chainId)), ...vaults.keys()];
    for (const domain of domains) {
      const seen = await getTableRows<{
        nonce: number | string;
        beneficiary: string;
        amount: number | string;
        at: string;
      }>(chain, { code: bridge, scope: String(domain), table: 'seen' });

      for (const s of seen) {
        const creditedAt = Math.floor(Date.parse(`${s.at}Z`) / 1000);
        // `seen` knows when the credit happened, not where the deposit started:
        // what the stream, the crossings or history already recorded of the
        // source side is kept, and the credit's time stands in only until then.
        this.store.upsertTransfer({
          key: depositKey(domain, String(s.nonce)),
          direction: 'deposit',
          ref: Number(s.nonce),
          status: 'credited',
          account: s.beneficiary,
          domain,
          amount: String(s.amount),
          firstSeen: { block: 0, time: creditedAt },
          dst_time: creditedAt,
        });
      }
      credited += seen.length;

      // Booked, but not handed on yet. Read after `seen` so it moves those
      // rows forward rather than being moved back by them.
      const parked = await getTableRows<{ nonce: number | string }>(chain, {
        code: bridge,
        scope: String(domain),
        table: 'parked',
      });
      for (const p of parked) this.markParked(domain, Number(p.nonce));
    }

    await this.freezeMissingHandovers();
    this.pruneWindow();
    return { withdrawals: wdraws.length, deposits: credited, froze };
  }

  /**
   * Freeze a burn the stream did not catch, from local leaves plus the node.
   *
   * The tree comes from a checkpoint and the leaf window — local and fast. The
   * two halves that cannot be local are the block's traces and the finality data
   * around it, and those are exactly what retention takes away, so this either
   * works within the window or reports that it never will.
   */
  private async freezeByReplay(burn: number, id: number): Promise<boolean> {
    try {
      const { tree, root } = await this.treeAt(burn);
      const window = await fetchFinalityRange(this.cfg.ship, burn - 1, burn + 12);

      // The chain's own opinion of this root, before anything is built on it.
      // The live path inherits a tree that checks itself against block headers
      // as it goes; a replay does not, and a replay over a window with a hole in
      // it would produce a tree that folds perfectly to a root nobody else has.
      // One header settles it.
      const { rBlock } = locateRootBlocks(window, burn);
      const carried = (await getBlock(this.cfg.savanna, rBlock)).action_mroot;
      if (carried !== root) {
        throw new Error(
          `the replayed tree says the root at ${burn} is ${root}, but block ${rBlock} carries ` +
            `${carried} — the local tree and the chain disagree`,
        );
      }
      const traced = await fetchRange(this.cfg.ship, burn, burn, true, 60_000);
      const block = traced.blocks.find((b) => b.this_block.block_num === burn);
      if (!block?.traces) throw new Error(`no action traces for block ${burn}`);
      const traces = decodeTraces(traced.abi, block.traces);

      // This withdrawal and no other. The block may carry burns bound for an
      // Antelope chain, which have no EVM proof to build — trying them all made
      // one of those abort the block, and an EVM burn after it was never frozen.
      const w = blockWdlogs(traces, this.cfg.savanna.accounts.bridge).find((x) => x.id === BigInt(id));
      if (!w) throw new Error(`block ${burn} carries no wdlog for withdrawal ${id}`);
      if (!w.frozen) throw new Error(`withdrawal ${id} is bound for an Antelope chain; its relayer proves it`);

      const artifact = await this.artifactFor(w, { burn, window, traces, tree, rootAtBurn: root });
      this.record(artifact, burn, w.trxId);
      return true;
    } catch (err) {
      this.store.incident('backfill-failed', `withdrawal ${id} at ${burn}: ${(err as Error).message}`);
      console.log(`[savanna] backfill failed for withdrawal ${id}: ${(err as Error).message}`);
      return false;
    }
  }

  /**
   * A tree that has appended the leaf for `block`, by whichever route works.
   *
   * Local leaves first, because they are memory-speed and bounded only by the
   * window. State-history second, for the case the window cannot cover: a fresh
   * instance, whose leaf file starts empty while the node still holds days of
   * blocks. Both need a checkpoint from BEFORE the burn — a tree can only emit a
   * branch for a leaf it appended itself — and when there is none, neither can
   * help and the message says what can.
   */
  private async treeAt(block: number): Promise<{ tree: IncrementalTree; root: string }> {
    try {
      const local = treeThrough(this.cfg.checkpointDir, this.leaves, block, block);
      return { tree: local.tree, root: local.root };
    } catch (localErr) {
      const start = newestCheckpointAtOrBefore(this.cfg.checkpointDir, block - 1);
      if (!start) {
        throw new Error(
          `no checkpoint before block ${block}, and the leaf window does not reach it ` +
            `(${(localErr as Error).message}). Rebuilding from the seed is a one-off job: ` +
            `scripts/build-withdrawal.ts ${block}`,
        );
      }
      const tracker = new PolicyTracker();
      tracker.restore(start.frontier.policies ?? []);
      let root = '';
      console.log(
        `[savanna] replaying ${block - start.frontier.last_block} blocks over state-history ` +
          `for block ${block} (the leaf window does not reach it)`,
      );
      await buildTree({
        chain: this.cfg.savanna,
        ship: this.cfg.ship,
        tree: start.tree,
        seedBlock: start.frontier.last_block,
        seedRoot: start.frontier.root,
        to: block,
        warmup: start.frontier.policies?.length ? 0 : 100_000,
        tracker,
        onRecoveredActionRoot: (n, root) =>
          console.log(`[savanna] replay: block ${n} action_mroot rebuilt from traces, ${root.slice(0, 16)}…`),
        slotFromHeader: (n) => headerSlot(this.cfg.savanna, n),
        onLeaf: (n, _leaf, rootAfter) => {
          if (n === block) root = rootAfter;
        },
      });
      if (!root) throw new Error(`the replay never appended block ${block}`);
      return { tree: start.tree, root };
    }
  }

  /** Drop leaf chunks past the window the routes' deadlines call for. */
  private pruneWindow(): void {
    const last = this.leaves.lastBlock;
    if (last === undefined) return;
    const keepFrom = last - this.windowBlocks;
    // A boundary that is not a number deletes, it does not keep: `prune` skips a
    // chunk only when `chunkLast >= keepFrom`, and every comparison with NaN is
    // false. That removed 1,009,242 leaves on 2026-09-23. Refuse loudly instead.
    if (!Number.isFinite(keepFrom)) {
      console.log(
        `[savanna] NOT pruning: boundary is ${keepFrom} (last ${last}, window ${this.windowBlocks})`,
      );
      return;
    }
    const dropped = this.leaves.prune(keepFrom);
    if (dropped) console.log(`[savanna] pruned ${dropped} leaves before ${keepFrom}`);
  }

  /** What `/health` reports, including the size the window is aiming at. */
  snapshot(): SettlementState & { windowTarget: number; bytes: number } {
    return {
      ...this.state,
      windowFrom: this.leaves.firstBlock,
      windowBlocks: this.leaves.count,
      windowTarget: this.windowBlocks,
      bytes: this.leaves.bytes(),
    };
  }
}
