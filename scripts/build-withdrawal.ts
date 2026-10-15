/**
 * Freeze a complete, permanent artifact for one withdrawal.
 *
 * A withdrawal proof has two halves and they are needed together:
 *
 *   submitRoot   makes one finality tree root trusted on Ethereum — a BLS
 *                pairing, 785k gas measured, paid once per root
 *   release      folds this withdrawal into that root — hashes only, 135k gas
 *
 * Both are written out here, so the pair stands on its own forever. That
 * matters because `TelosLightClient.trustedRoots` only ever accumulates: a root
 * accepted today is still accepted in a year, so an artifact built against it
 * never expires and never needs re-basing. Which in turn is why the bridge does
 * not have to retain block history — the finished artifact replaces it.
 *
 * ## Why this replays the chain
 *
 * A tree frontier is a cursor for appending, not an index. The siblings a branch
 * needs are interior nodes, and those exist only inside a tree instance that
 * appended the leaves under them. So proving block X means holding a tree that
 * was built through X — from a nearby checkpoint in seconds, or from the genesis
 * seed in minutes. A checkpoint is written at the end either way, so the next
 * withdrawal near this one is cheap.
 *
 *   node --experimental-strip-types scripts/build-withdrawal.ts <burnBlock> [outFile]
 */

import { readFileSync, writeFileSync } from 'node:fs';

import { savannaChain } from '../src/chains/savanna.ts';
import { fetchFinalityRange, fetchRange } from '../src/savanna/ship.ts';
import { decodeTraces } from '../src/savanna/traces.ts';
import { buildTree, headerRootFor, headerSlot } from '../src/savanna/treeBuilder.ts';
import {
  readFrontier,
  saveCheckpoint,
  frontierOf,
  newestCheckpointAtOrBefore,
} from '../src/savanna/frontier.ts';
import { PolicyTracker } from '../src/savanna/finality.ts';
import { findPolicyPublication } from '../src/savanna/policyChain.ts';
import {
  assembleWithdrawalArtifact,
  artifactToJson,
  locateRootBlocks,
} from '../src/savanna/withdrawalArtifact.ts';
import { antelopeRpc } from '../src/net/antelope.ts';
import { requiredEnv } from '../src/env.ts';

const SHIP = requiredEnv('SHIP_URL', 'the state-history socket of a Telos node');
const chain = savannaChain('telos-mainnet');
const BRIDGE = process.env.BRIDGE_ACCOUNT ?? 'ethbridge111';
const CHECKPOINTS = process.env.CHECKPOINT_DIR ?? 'data/checkpoints';
const SEED = process.env.TREE_SEED ?? 'data/tree-seed.json';
const WARMUP = Number(process.env.WARMUP ?? 100_000);
const CHECKPOINT_EVERY = Number(process.env.CHECKPOINT_EVERY ?? 50_000);

const burn = Number(process.argv[2]);
if (!Number.isFinite(burn)) throw new Error('usage: build-withdrawal.ts <burnBlock> [outFile]');
const outFile = process.argv[3] ?? `data/withdrawal-${burn}.json`;

/** `get_block` and friends, retrying, from the registry's endpoint list. */
const rpc = (path: string, body: unknown) => antelopeRpc(chain, path, body);

// --- the three blocks this turns on -------------------------------------------
//
//   burn  the wdlog is here, and its leaf carries the block's action_mroot
//   R     the first block whose certificate claims `burn`; the root it carries is
//         therefore the tree root as of `burn`, and that is the root to submit
//   C     the first block whose certificate claims R; it holds the signature over
//         R's finality digest, which is what makes that root trustworthy

const window = await fetchFinalityRange(SHIP, burn - 1, burn + 12);
const { rBlock, cBlock } = locateRootBlocks(window, burn);

console.log(`burn block ${burn}`);
console.log(`  root as of it is carried by block ${rBlock}, signed by the certificate in ${cBlock}`);

// --- a tree that spans the burn block -----------------------------------------

const start =
  newestCheckpointAtOrBefore(CHECKPOINTS, burn - 1) ??
  (() => {
    const { frontier, tree } = readFrontier(SEED);
    return { path: SEED, frontier, tree };
  })();

console.log(`\nstarting from ${start.path}: block ${start.frontier.last_block}`);
const distance = burn - start.frontier.last_block;
console.log(`  ${distance.toLocaleString('en-US')} blocks to replay`);

const tracker = new PolicyTracker();
const carriedPolicies = start.frontier.policies ?? [];
if (carriedPolicies.length) {
  tracker.restore(carriedPolicies);
  console.log(`  tracker restored with ${carriedPolicies.length} policies, no warm-up needed`);
}

let rootAtBurn: string | undefined;
const started = Date.now();

const result = await buildTree({
  chain,
  ship: SHIP,
  tree: start.tree,
  seedBlock: start.frontier.last_block,
  seedRoot: start.frontier.root,
  to: burn,
  // A checkpoint that carries policies already knows what a warm-up would teach.
  warmup: carriedPolicies.length ? 0 : WARMUP,
  tracker,
  slotFromHeader: (n) => headerSlot(chain, n),
  onLeaf: (n, _leaf, rootAfter) => {
    if (n === burn) rootAtBurn = rootAfter;
    // Checkpoint along the way, not only at the end. A checkpoint is only useful
    // to a proof for a LATER block, so one written at `burn` does nothing for
    // re-proving `burn` itself — and without these the next cold proof pays the
    // whole replay again. Each costs popcount(leaves) hashes on disk.
    if ((n - start.frontier.last_block) % CHECKPOINT_EVERY === 0) {
      saveCheckpoint(
        CHECKPOINTS,
        frontierOf(start.tree, n, start.frontier.leaves + (n - start.frontier.last_block), tracker.snapshot()),
      );
    }
  },
  onProgress: (s) => {
    const rate = s.appended / ((Date.now() - started) / 1000);
    console.log(
      `  ${s.at}  ${s.appended.toLocaleString('en-US')} appended  ${Math.round(rate)}/s  ` +
        `${((burn - s.at) / rate / 60).toFixed(0)} min left`,
    );
  },
  // Every root computed is an assertion a producer signed. Checking a few makes a
  // divergence surface here rather than as a proof Ethereum silently rejects.
  verifyEvery: 50_000,
  onVerify: async (n, root) => {
    const recorded = await headerRootFor(chain, n);
    if (recorded === undefined) return;
    if (root !== recorded) {
      throw new Error(`root at ${n} is ${root}, chain says ${recorded}`);
    }
    console.log(`  root at ${n} matches the chain`);
  },
});

if (!rootAtBurn) throw new Error(`the build never appended block ${burn}`);
console.log(
  `\nbuilt through ${result.at}: root ${rootAtBurn}` +
    ` (${result.computedDigests} digests computed, ${result.laggingClaims} over a lagging claim)`,
);

// The root the chain says block R carries must be the root just computed. This is
// the whole build checked in one comparison, against a value a producer signed.
const rHeader = await rpc('/v1/chain/get_block', { block_num_or_id: rBlock });
if (rHeader.action_mroot !== rootAtBurn) {
  throw new Error(
    `block ${rBlock} carries finality_mroot ${rHeader.action_mroot}, but the tree built here ` +
      `says ${rootAtBurn} — the tree and the chain disagree`,
  );
}
console.log(`  confirmed: block ${rBlock} carries exactly this root`);

saveCheckpoint(CHECKPOINTS, frontierOf(start.tree, burn, start.frontier.leaves + result.appended, result.tracker.snapshot()));

// --- the artifact ------------------------------------------------------------

const traced = await fetchRange(SHIP, burn, burn, true, 60_000);
const block = traced.blocks.find((b) => b.this_block.block_num === burn);
if (!block?.traces) throw new Error(`no action traces for block ${burn}`);

const artifact = await assembleWithdrawalArtifact({
  chain,
  bridgeAccount: BRIDGE,
  burn,
  window,
  traces: decodeTraces(traced.abi, block.traces),
  tree: start.tree,
  rootAtBurn,
  tracker: result.tracker,
  policyFor: async (generation, atBlock) =>
    (await findPolicyPublication(SHIP, atBlock, generation)).policy,
  rawBlock: (n) => rpc('/v1/chain/get_raw_block', { block_num_or_id: n }),
});

const { release, submitRoot } = artifact;
console.log(`\nrelease proof for withdrawal ${release.id}`);
console.log(`  ${release.amount} canonical units to ${release.recipient} on domain ${release.domain}`);
console.log(
  `  action branch ${release.actionSiblings.length} steps, ` +
    `tree branch ${release.treeSiblings.length} steps`,
);

console.log(`\nsubmitRoot arguments for block ${artifact.rootBlock}`);
console.log(`  finalityMroot ${submitRoot.finality.finalityMroot}`);
console.log(
  `  policy generation ${submitRoot.finality.activeGeneration}, ` +
    `last pending ${submitRoot.finality.lastPendingGeneration}`,
);
console.log(
  `  bits ${submitRoot.bits.length / 2 - 1} bytes, ` +
    `signature ${submitRoot.signature.length / 2 - 1} bytes, ${submitRoot.policyKeys.length} keys`,
);

writeFileSync(outFile, artifactToJson(artifact));
console.log(`\nwritten to ${outFile}`);
process.exit(0);
