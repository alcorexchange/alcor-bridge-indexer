/**
 * Appending finality-tree leaves from a state-history stream.
 *
 * Two things need this and they must not each have their own copy: the indexer
 * that keeps the tree at the chain's head, and the prover that replays to a block
 * it needs a branch through. A leaf is seven fields and a divergence in any of
 * them produces a root that is merely different — no exception, no bad decode,
 * just proofs that fold to nothing.
 *
 * ## Everything comes from finality_data
 *
 * The obvious source for a leaf's timestamp is the block header, and it is the
 * wrong one: a node keeps headers for `block-log-retain-blocks`, often a day,
 * while state-history keeps finality data for a month. Building from headers
 * caps the catch-up window at the *shorter* of the two.
 *
 * A block's finality data reports the timestamp AND the finality digest of the
 * block its certificate claims, so walking the stream yields both for nearly
 * every block, from the source with the longer memory.
 *
 *   action_mroot      `finality_data.action_mroot` — the real action root, not
 *                     the header field of that name, which under Savanna holds
 *                     the finality tree root instead
 *   timestamp         `latest_qc_claim_timestamp` of the block that claims it
 *   parent_timestamp  the previous block's, carried forward
 *   finality_digest   `latest_qc_claim_finality_digest` of the same
 *
 * ## The block nothing claims
 *
 * Roughly two blocks in a thousand are never claimed by any certificate, so they
 * have neither, and their digest is computed here. That path has one trap, and it
 * cost a full rebuild to find: the digest commits to the tree root as of the
 * block the certificate CLAIMS, not as of the block carrying it. Those coincide
 * whenever a block claims its predecessor — almost always — so using the current
 * root passes tens of thousands of blocks and then silently does not. Recent
 * roots are therefore kept and looked up by claim, and a lookback that reaches
 * past them throws rather than substituting the nearest.
 */

import WebSocket from 'ws';

import {
  decodeBlocksResult,
  encodeAck,
  encodeRequest,
  fetchRange,
  type FinalityData,
  type ShipBlock,
} from './ship.ts';
import { actionMrootFromTraces, decodeTraces } from './traces.ts';
import type { FinalizerPolicy } from './policyDiff.ts';
import { finalityLeafBytes } from './tree.ts';
import { finalityDigest, PolicyTracker } from './finality.ts';
import { timestampToSlot, type SlotEpoch } from '../proof/pack.ts';
import type { IncrementalTree } from '../proof/merkle.ts';
import { bare, toHex } from '../proof/hex.ts';
import { getBlock, type RpcEndpoints } from '../net/antelope.ts';

/** A block's timestamp slot, from its header: `slotFromHeader` for a chain with an RPC. */
export async function headerSlot(chain: SlotEpoch & RpcEndpoints, blockNum: number): Promise<number> {
  return timestampToSlot(chain, (await getBlock(chain, blockNum)).timestamp);
}

/**
 * The tree root as of `blockNum` that the chain itself records, or undefined
 * when its headers record none.
 *
 * Under Savanna a block's `action_mroot` header field carries the finality tree
 * root as of the block its certificate claims. So the next block states this
 * one's root — when it claims this one, which it nearly always does; when it
 * claims something else there is nothing to compare, and guessing would be
 * worse than skipping.
 */
export async function headerRootFor(chain: RpcEndpoints, blockNum: number): Promise<string | undefined> {
  const next = await getBlock(chain, blockNum + 1);
  return next.finality_extension?.qc_claim?.block_num === blockNum ? next.action_mroot : undefined;
}

/** How far back a lagging certificate may reach before the lookup gives up. */
const ROOT_MEMORY = 300;

/** Blocks of lead before concluding that nothing will ever claim a block. */
const CLAIM_LEAD = 8;

/** `end_block_num` meaning "keep sending". */
const FOREVER = 0xffff_ffff;

/** Results the node may have outstanding. Each one must be acked. */
const IN_FLIGHT = 64;

/** How long to wait before reopening a dropped follow stream. */
const RECONNECT_MS = 2_000;

export type BuildStats = {
  /** Last block whose leaf was appended. */
  at: number;
  appended: number;
  /** Digests the chain never reported, computed here instead. */
  computedDigests: number;
  /** How many of those sat over a certificate claiming further back than one block. */
  laggingClaims: number;
  httpHeaders: number;
  /** Blocks whose `action_mroot` state-history reported as zero, rebuilt from traces. */
  recoveredActionRoots: number;
  /** The chain's head as the socket last reported it. Zero until the first message. */
  head: number;
};

const ZERO_ROOT = /^0+$/;

/**
 * A block's real `action_mroot`, rebuilt from its own traces.
 *
 * State-history can report 32 zero bytes here, and it did on Telos after a
 * restart: a node that comes back from a snapshot and re-applies the blocks it
 * had not yet finalized when it stopped records their traces — the `onblock`
 * receipt is there — but leaves `finality_data.action_mroot` empty. Two such
 * blocks at the seam of one restart were enough to poison every finality root
 * after them, because a leaf built on the zero value is simply a different leaf
 * and the tree has no way to object.
 *
 * Zero is never a legitimate value: every Antelope block carries at least the
 * `onblock` receipt, so an empty action tree cannot occur on a real block. That
 * makes the zero unambiguous as a signal and safe to replace. The replacement is
 * the same `actionMrootFromTraces` withdrawal proofs already depend on, checked
 * against the node's own value on the blocks either side of the seam, and every
 * root built from it is still verified against the chain periodically.
 *
 * One block, fetched on its own, because the main stream usually runs without
 * traces during a catch-up — they are most of the bytes. If the traces carry no
 * receipt either, there is nothing trustworthy to build from, and this throws
 * rather than let the tree continue on a guess.
 */
export async function recoverActionMroot(ship: string, blockNum: number): Promise<string> {
  const { abi, blocks } = await fetchRange(ship, blockNum, blockNum, true);
  const b = blocks.find((x) => x.this_block.block_num === blockNum);
  if (!b?.traces) {
    throw new Error(
      `block ${blockNum}: state-history reported an all-zero action_mroot and served no ` +
        `traces to rebuild it from. The leaf cannot be built correctly; refusing to guess.`,
    );
  }
  const root = actionMrootFromTraces(decodeTraces(abi, b.traces));
  if (ZERO_ROOT.test(root)) {
    throw new Error(
      `block ${blockNum}: all-zero action_mroot, and its traces carry no receipt either — ` +
        `every block has at least onblock, so this node's data for it is unusable.`,
    );
  }
  return root;
}

export type TreeBuildOptions = {
  chain: SlotEpoch;
  /** state-history websocket */
  ship: string;
  /** a tree already holding every leaf up to `seedBlock` */
  tree: IncrementalTree;
  /** the block that tree's last leaf belongs to, and the root as of it */
  seedBlock: number;
  seedRoot: string;
  /** Last block to append a leaf for. Ignored, and may be omitted, when following. */
  to?: number;
  /**
   * Stay on the socket past `to` instead of resolving.
   *
   * This is the difference between a catch-up and a process. A followed stream
   * ends only on `signal`, or on an error it cannot retry.
   */
  follow?: boolean;
  /** Stops a followed stream, resolving with the stats so far. */
  signal?: AbortSignal;
  /**
   * Ask the node for action traces as well.
   *
   * Off during a catch-up, where traces are most of the bytes and none of them
   * are wanted; on at the head, where a block is two a second and the traces are
   * the only way to see a bridge action at the moment it happens.
   */
  fetchTraces?: boolean;
  /**
   * Every block as the socket delivered it: position, finality data, traces.
   *
   * Called when the block ARRIVES, which is before its leaf is appended — a leaf
   * waits for the certificate that claims it, a block or two later. A caller
   * that needs both must hold the block until `onLeaf` reaches the same number.
   *
   * The ABI comes with it because traces are a deep variant structure that
   * changes between Spring versions, and the node is the only authority on which
   * version it speaks.
   */
  onBlock?: (block: ShipBlock, abiJson: string) => void;
  /** A finalizer policy as the chain publishes it, with its full key list. */
  onPolicy?: (policy: FinalizerPolicy, blockNum: number, slot: number) => void;
  /** Called once, when the appended block first reaches the chain's head. */
  onCaughtUp?: (blockNum: number) => void;
  /**
   * Blocks before `seedBlock + 1` to read without appending.
   *
   * A block no certificate claims needs the policy pending at the time, and the
   * chain publishes a policy only at a transition — about 72,000 blocks apart. A
   * tracker that starts cold therefore cannot compute such a digest at all. Pass
   * a tracker already carrying the policies instead, and this can be zero.
   */
  warmup?: number;
  tracker?: PolicyTracker;
  /** A block's timestamp slot, for the rare one no certificate ever claimed. */
  slotFromHeader: (blockNum: number) => Promise<number>;
  /** Called for every leaf, in block order. */
  onLeaf?: (blockNum: number, leaf: Uint8Array, rootAfter: string) => void;
  /** Called every few seconds with progress. */
  onProgress?: (s: BuildStats) => void;
  /**
   * A block whose `action_mroot` state-history reported as 32 zero bytes, and the
   * root rebuilt from its own traces instead. Rare — see `recoverActionMroot` —
   * and worth a log line every time, because it means the node's data was wrong.
   */
  onRecoveredActionRoot?: (blockNum: number, root: string) => void;
  /** Called every `verifyEvery` leaves so the caller can check a root. */
  verifyEvery?: number;
  onVerify?: (blockNum: number, root: string) => Promise<void>;
};

export type BuildResult = BuildStats & {
  tracker: PolicyTracker;
  root: string;
};

/**
 * Stream from `seedBlock + 1` to `to`, appending a leaf per block.
 *
 * Resolves when `to` has been appended. The tree is mutated in place, and keeps
 * every interior node it forms — which is what makes branches available after
 * this returns, and what makes a long run expensive in memory.
 */
export function buildTree(o: TreeBuildOptions): Promise<BuildResult> {
  const tracker = o.tracker ?? new PolicyTracker();
  const from = o.seedBlock + 1;
  const warmFrom = Math.max(1, from - (o.warmup ?? 0));
  const stopAt = o.to;
  if (!o.follow && stopAt === undefined) {
    throw new Error('buildTree needs a `to` block, or `follow` to stay on the head');
  }

  const fdOf = new Map<number, FinalityData>();
  /** The slot of every block already appended or warmed past — the parent's is needed. */
  const slotOf = new Map<number, number>();
  const rootAt = new Map<number, string>([[o.seedBlock, bare(o.seedRoot)]]);

  /**
   * Certificate claims, kept by the block that MADE them.
   *
   * A claim is only as good as the block carrying it, and at the head that block
   * can still be forked out. Keyed by claimer, a fork that resends a number
   * replaces what the abandoned block said, and a leaf reads only claims whose
   * claimer is already irreversible. Kept by claimed number instead — as the
   * first version did — the abandoned block's claim stayed behind and became a
   * leaf the chain never agreed to: five of them on 2026-09-25.
   */
  const claimBy = new Map<number, { claimed: number; slot: number; digest: string }>();
  const claimersOf = new Map<number, Set<number>>();

  const forgetClaim = (claimer: number) => {
    const c = claimBy.get(claimer);
    if (!c) return;
    claimBy.delete(claimer);
    const set = claimersOf.get(c.claimed);
    set?.delete(claimer);
    if (set && !set.size) claimersOf.delete(c.claimed);
  };

  /** A claim of `n` carried by a block at or below `horizon`, which is final. */
  const finalClaimOf = (n: number, horizon: number) => {
    for (const claimer of claimersOf.get(n) ?? []) {
      if (claimer <= horizon) return claimBy.get(claimer);
    }
    return undefined;
  };

  let next = warmFrom;
  /** The newest block delivered on the branch the node is on now. */
  let highest = 0;
  /** The node's last irreversible block, as of the latest message. */
  let lib = 0;
  let caughtUp = false;
  const stats: BuildStats = {
    at: o.seedBlock,
    appended: 0,
    computedDigests: 0,
    laggingClaims: 0,
    httpHeaders: 0,
    recoveredActionRoots: 0,
    head: 0,
  };
  let lastProgress = Date.now();
  let processing = false;

  return new Promise<BuildResult>((resolve, reject) => {
    let ws: WebSocket | undefined;
    let stopped = false;
    let abi = '';

    const close = () => {
      stopped = true;
      try {
        ws?.close();
      } catch {
        // Already gone; the only thing that mattered was not reconnecting.
      }
    };
    const finish = () => {
      close();
      resolve({ ...stats, tracker, root: toHex(o.tree.root()) });
    };
    const fail = (e: Error) => {
      close();
      reject(e);
    };

    o.signal?.addEventListener('abort', () => !stopped && finish(), { once: true });

    async function drain(): Promise<void> {
      if (processing) return;
      processing = true;
      try {
        for (;;) {
          const fd = fdOf.get(next);
          if (!fd) break;

          const warming = next < from;

          // Only final blocks become leaves. Below the node's LIB nothing can be
          // forked out any more, so a block, and every claim made by a block, at
          // or under this line is the one the chain keeps. In a catch-up the LIB
          // is far ahead and this is simply what has arrived.
          const horizon = Math.min(highest, lib);
          if (next > horizon) break;

          const claim = finalClaimOf(next, horizon);
          let slot = claim?.slot;
          let digest = claim?.digest;

          // Nothing final has claimed this block yet. Give the stream a lead of a
          // few final blocks before concluding that nothing ever will.
          if (!claim && horizon < next + CLAIM_LEAD) break;

          if (slot === undefined) {
            slot = await o.slotFromHeader(next);
            stats.httpHeaders++;
          }
          const parentSlot = slotOf.get(next - 1) ?? slot - 1;

          // Learn any policy this block publishes. Done here rather than on
          // arrival because a policy's start timestamp is the block's own, and
          // that only becomes known when a later certificate claims it.
          const published = tracker.observe(o.chain, slot, fd);
          if (published) o.onPolicy?.(published, next, slot);

          if (warming) {
            slotOf.set(next, slot);
            fdOf.delete(next);
            for (const claimer of [...(claimersOf.get(next) ?? [])]) forgetClaim(claimer);
            slotOf.delete(next - 2);
            next++;
            continue;
          }

          if (digest === undefined) {
            const generation = fd.last_pending_finalizer_policy_generation;
            if (!tracker.known(generation)) {
              return fail(
                new Error(
                  `block ${next} was never claimed and its policy (generation ${generation}) ` +
                    `is unknown, so its digest cannot be computed. Start from a window ` +
                    `containing a policy transition, or seed the tracker.`,
                ),
              );
            }
            const claimed = fd.latest_qc_claim_block_num;
            const mroot = rootAt.get(claimed);
            if (mroot === undefined) {
              return fail(
                new Error(
                  `block ${next} was never claimed, so its digest has to be computed — but ` +
                    `that needs the tree root as of block ${claimed}, which its own ` +
                    `certificate claims and this run never held.`,
                ),
              );
            }
            const lp = tracker.lastPending(generation);
            digest = finalityDigest(o.chain, {
              finalityData: fd,
              finalityMroot: mroot,
              timestamp: slot,
              lastPendingPolicyDigest: lp.digest,
              lastPendingPolicyStartSlot: lp.startSlot,
            });
            stats.computedDigests++;
            if (claimed !== next - 1) stats.laggingClaims++;
          }

          let actionMroot = fd.action_mroot;
          if (ZERO_ROOT.test(actionMroot)) {
            try {
              actionMroot = await recoverActionMroot(o.ship, next);
            } catch (e) {
              return fail(e as Error);
            }
            stats.recoveredActionRoots++;
            o.onRecoveredActionRoot?.(next, actionMroot);
          }

          const leaf = finalityLeafBytes(o.chain, {
            majorVersion: fd.major_version,
            minorVersion: fd.minor_version,
            blockNum: next,
            timestamp: slot,
            parentTimestamp: parentSlot,
            finalityDigest: digest,
            actionMroot,
          });
          o.tree.append(leaf);
          stats.appended++;
          stats.at = next;

          const rootAfter = toHex(o.tree.root());
          slotOf.set(next, slot);
          rootAt.set(next, rootAfter);
          o.onLeaf?.(next, leaf, rootAfter);

          fdOf.delete(next);
          for (const claimer of [...(claimersOf.get(next) ?? [])]) forgetClaim(claimer);
          slotOf.delete(next - 2);
          rootAt.delete(next - ROOT_MEMORY);

          if (o.verifyEvery && o.onVerify && stats.appended % o.verifyEvery === 0) {
            await o.onVerify(next, rootAfter);
          }

          // The head the socket reports is one the node has, not one this has
          // appended — and a leaf now waits for finality, so arriving is `next`
          // reaching the node's LIB, announced once.
          if (o.follow && !caughtUp && lib > 0 && next >= lib - 1) {
            caughtUp = true;
            o.onCaughtUp?.(next);
          }

          if (!o.follow && next === stopAt) {
            finish();
            return;
          }
          next++;
        }
      } catch (e) {
        fail(e as Error);
      } finally {
        processing = false;
      }
    }

    /**
     * Open the socket and ask for blocks from `startBlock`.
     *
     * Separate from the promise so a dropped follow stream can call it again.
     * Resuming from `next` rather than from the seed is what makes a reconnect
     * cost nothing: the tree, the tracker and the slot of the previous block are
     * all still in hand, so there is nothing to warm up a second time.
     */
    function connect(startBlock: number): void {
      abi = '';
      ws = new WebSocket(o.ship, { maxPayload: 512 * 1024 * 1024 });

      ws.on('message', (data: Buffer) => {
        if (!abi) {
          abi = data.toString('utf8'); // the first message is the ABI, as JSON
          // A finite run reads past `to`: a block nobody has claimed yet waits for
          // CLAIM_LEAD final blocks before its digest is computed, and asking for
          // `to + 1` alone left such a run waiting on blocks it never requested.
          const end = o.follow ? FOREVER : stopAt! + CLAIM_LEAD + 2;
          ws!.send(encodeRequest(startBlock, end, !!o.fetchTraces, IN_FLIGHT));
          return;
        }

        // Ack every result, including the empty ones past the requested range;
        // without it the stream stops after IN_FLIGHT and looks like a hung
        // socket rather than a finished one.
        ws!.send(encodeAck(1));

        let block;
        try {
          block = decodeBlocksResult(new Uint8Array(data));
        } catch (e) {
          return fail(e as Error);
        }
        if (!block?.finality_data) return;

        stats.head = block.head.block_num;
        lib = block.last_irreversible.block_num;
        const n = block.this_block.block_num;
        const fd = block.finality_data;

        // A number already delivered means the node switched branches, or a
        // reconnect is replaying: everything from here up came from the branch
        // being left, and none of it may be read again.
        if (n <= highest) {
          for (let k = n; k <= highest; k++) {
            fdOf.delete(k);
            forgetClaim(k);
          }
        }
        highest = n;

        // Handed over before the leaf exists: a leaf waits for its block to be
        // final and for a final certificate that claims it.
        if (n >= from) o.onBlock?.(block, abi);

        fdOf.set(n, fd);

        const claimed = fd.latest_qc_claim_block_num;
        if (claimed && claimed >= next) {
          claimBy.set(n, {
            claimed,
            slot: fd.latest_qc_claim_timestamp,
            digest: fd.latest_qc_claim_finality_digest,
          });
          if (!claimersOf.has(claimed)) claimersOf.set(claimed, new Set());
          claimersOf.get(claimed)!.add(n);
        }

        void drain();

        if (o.onProgress && Date.now() - lastProgress > 30_000) {
          lastProgress = Date.now();
          o.onProgress({ ...stats });
        }
      });

      // A transport failure is not fatal to a follower: `close` follows it and
      // reconnects. For a finite run there is nothing to resume into, so it is.
      ws.on('error', (e) => {
        if (!o.follow || stopped) fail(e as Error);
        else o.onProgress?.({ ...stats });
      });

      ws.on('close', () => {
        if (stopped) return;
        if (o.follow) {
          setTimeout(() => !stopped && connect(next), RECONNECT_MS).unref?.();
          return;
        }
        // A close before `to` means the node ended the stream early — silence
        // here would look like a tree that simply stopped growing.
        if (stats.at < stopAt!) {
          reject(new Error(`stream closed at block ${stats.at}, short of ${stopAt}`));
        }
      });
    }

    connect(warmFrom);
  });
}
