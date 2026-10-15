/**
 * Catch the finality tree up to a block, once, and stop.
 *
 * The daemon does this continuously and does not terminate; this is the one-shot
 * form, and it is worth keeping for the two jobs a daemon is the wrong shape
 * for: bootstrapping a fresh instance from the genesis seed, and laying down a
 * checkpoint *before* a particular block so that a withdrawal there can be
 * proved at all. A branch needs a tree that appended the leaf itself, so a burn
 * with no checkpoint before it cannot be proved from a frontier however recent.
 *
 * Everything it does — reading the stream, the leaf's seven fields, the digest a
 * block nobody claimed needs — is `src/savanna/treeBuilder.ts`, the same code the
 * indexer runs. It used to be a second copy of all of it, which is a bad way to
 * hold a leaf layout: a divergence in any of those fields yields a root that is
 * merely different, with no exception and no bad decode.
 *
 *   node services/indexer/buildTree.ts <toBlock> [stateFile]
 */

import { existsSync } from 'node:fs';

import { followedChain, savannaChain } from '../../src/chains/savanna.ts';
import { buildTree, headerRootFor, headerSlot } from '../../src/savanna/treeBuilder.ts';
import { PolicyTracker } from '../../src/savanna/finality.ts';
import { requiredEnv } from '../../src/env.ts';
import {
  readFrontier,
  writeFrontier,
  frontierOf,
  saveCheckpoint,
} from '../../src/savanna/frontier.ts';

// TREE_CHAIN names a followed chain (Vaulta) instead of the ledger's own.
const chain = process.env.TREE_CHAIN ? followedChain(process.env.TREE_CHAIN) : savannaChain();
const SHIP = requiredEnv('SHIP_URL', `the state-history socket of a '${chain.id}' node`);

const toBlock = Number(process.argv[2]);
if (!Number.isFinite(toBlock)) throw new Error('usage: buildTree.ts <toBlock> [stateFile]');

const stateFile = process.argv[3] ?? 'data/tree-state.json';
const seedFile = process.env.TREE_SEED ?? 'data/tree-seed.json';
const checkpointDir = process.env.CHECKPOINT_DIR ?? 'data/checkpoints';
const checkpointEvery = Number(process.env.CHECKPOINT_EVERY ?? 50_000);
const verifyEvery = Number(process.env.VERIFY_EVERY ?? 50_000);
/**
 * Blocks read without appending, so the policy tracker learns what it needs.
 *
 * A block no certificate claims needs its digest computed, and that needs the
 * policy pending at the time — published only at a transition, about 86,400
 * blocks apart. A checkpoint that carries its policies needs none of this.
 */
const WARMUP = Number(process.env.WARMUP ?? 100_000);

// `readFrontier` re-folds the frontier and refuses one that recorded a mismatch,
// so a tree the chain disagrees with cannot be resumed into by accident.
const source = existsSync(stateFile) ? stateFile : seedFile;
const { frontier, tree } = readFrontier(source);
console.log(
  `${source === stateFile ? 'resuming from' : 'seeding from'} ${source}: ` +
    `block ${frontier.last_block}, ${frontier.leaves.toLocaleString('en-US')} leaves`,
);

if (toBlock <= frontier.last_block) {
  console.log(`already at ${frontier.last_block}; nothing to do`);
  process.exit(0);
}

const tracker = new PolicyTracker();
tracker.restore(frontier.policies ?? []);
if (frontier.policies?.length) {
  console.log(`  tracker restored with ${frontier.policies.length} policies, no warm-up needed`);
}

const started = Date.now();
let appended = 0;
let mismatches = 0;

console.log(
  `streaming ${frontier.last_block + 1}..${toBlock} ` +
    `(${(toBlock - frontier.last_block).toLocaleString('en-US')} blocks)`,
);

const save = (at: number) =>
  writeFrontier(stateFile, {
    ...frontierOf(tree, at, frontier.leaves + appended, tracker.snapshot()),
    mismatches,
  });

const result = await buildTree({
  chain,
  ship: SHIP,
  tree,
  seedBlock: frontier.last_block,
  seedRoot: frontier.root,
  to: toBlock,
  warmup: frontier.policies?.length ? 0 : WARMUP,
  tracker,
  slotFromHeader: (n) => headerSlot(chain, n),
  onLeaf: (n) => {
    appended++;
    // Checkpoints along the way, not only at the end. One written at the target
    // helps nothing that needs to prove the target itself, and without them the
    // next cold proof pays the whole replay again.
    if (appended % checkpointEvery === 0) {
      saveCheckpoint(
        checkpointDir,
        frontierOf(tree, n, frontier.leaves + appended, tracker.snapshot()),
      );
    }
  },
  onRecoveredActionRoot: (n, root) =>
    console.log(`  block ${n}: all-zero action_mroot in state-history, rebuilt ${root.slice(0, 16)}… from traces`),
  onProgress: (s) => {
    save(s.at);
    const rate = s.appended / ((Date.now() - started) / 1000);
    console.log(
      `  ${s.at}  ${s.appended.toLocaleString('en-US')} appended  ${Math.round(rate)}/s  ` +
        `${((toBlock - s.at) / rate / 60).toFixed(0)} min left  ${mismatches} mismatches`,
    );
  },
  // Every root computed is an assertion a producer signed, and an error anywhere
  // propagates into every later root, so an occasional check catches it with a
  // block number attached rather than as a proof the far chain refuses.
  verifyEvery,
  onVerify: async (n, root) => {
    const recorded = await headerRootFor(chain, n);
    if (recorded === undefined) return;
    if (recorded === root) {
      console.log(`  root at ${n} matches the chain`);
      return;
    }
    mismatches++;
    console.log(`  MISMATCH at ${n}: computed ${root}, chain says ${recorded}`);
  },
});

save(result.at);
saveCheckpoint(
  checkpointDir,
  frontierOf(tree, result.at, frontier.leaves + appended, result.tracker.snapshot()),
);

const secs = (Date.now() - started) / 1000;
console.log(
  `\ndone: ${result.appended.toLocaleString('en-US')} leaves in ${(secs / 60).toFixed(1)} min ` +
    `(${Math.round(result.appended / secs)}/s)`,
);
console.log(`through block ${result.at}, ${frontier.leaves + appended} leaves total`);
console.log(`root ${result.root}`);
console.log(
  `${result.recoveredActionRoots} action roots rebuilt from traces, ` +
  `${result.computedDigests} digests computed locally (${result.laggingClaims} of them over a ` +
    `certificate that lagged a block or more), ${result.httpHeaders} headers fetched, ` +
    `${mismatches} mismatches`,
);
process.exit(mismatches === 0 ? 0 : 1);
