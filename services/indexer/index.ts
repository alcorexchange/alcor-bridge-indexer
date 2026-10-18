/**
 * The indexer: one process, one bridge pair, no keys.
 *
 * It watches both chains, keeps the finality tree at the head, freezes a proof
 * the moment a crossing starts, and serves all of it over HTTP. It signs
 * nothing and pushes nothing — every path it prepares is permissionless and
 * verified on chain, so if this process disappears the bridge keeps working and
 * proofs merely get slower to assemble. That property is worth more than any
 * feature here and is the reason it stays an observer.
 *
 * Three loops, deliberately independent:
 *
 *   savanna     the state-history stream; reconnects and resumes by itself
 *   evm         a log poller; catches up in spans and remembers its position
 *   reconcile   the slow, authoritative pass over both chains' own tables,
 *               which is what finds anything the two streams missed
 *
 * A failure in one must not stop the others, and none of them may stop the API:
 * "the tree is four hours behind" is the single most useful thing this can say,
 * and it can only say it while it is still answering.
 *
 *   node --experimental-strip-types services/indexer/index.ts [--check]
 */

import { loadConfig } from './config.ts';
import { Store } from './db.ts';
import { SettlementFollower } from './savanna.ts';
import { EvmFollower } from './evm.ts';
import { resolveRootBlocks } from './roots.ts';
import { BlockrootKeeper } from './blockroot.ts';
import { ingestCrossings } from './crossings.ts';
import { followSuiVault } from './suiVault.ts';
import { crossingsFiles } from '../../src/chains/antelope.ts';
import { backfillFromHistory } from './history.ts';
import { createApi } from './api.ts';
import { followSwaps, swapChains } from './swaps.ts';

const cfg = loadConfig();
const startedAt = Date.now();

if (process.argv.includes('--check')) {
  // Validates a deployment without opening a socket or a stream: every path,
  // endpoint and account this instance would use, resolved.
  console.log(
    JSON.stringify(
      {
        instance: cfg.instance,
        savanna: { chain: cfg.savanna.id, rpc: cfg.savanna.rpc, ship: cfg.ship, accounts: cfg.savanna.accounts },
        evm: {
          chain: cfg.evm.id,
          exec: cfg.sources[0].exec,
          beacon: cfg.beaconUrls,
          vault: cfg.evm.vault,
          withdrawals: cfg.evm.withdrawals,
          lightClient: cfg.evm.lightClient,
        },
        antelope: cfg.antelope.map((a) => ({
          chain: a.chain.id,
          consensus: a.chain.consensus,
          rpc: a.rpc,
          history: a.history,
          keeper: a.keeper ? { ship: a.keeper.ship, dir: a.keeper.dir, seed: a.keeper.seedFile } : null,
        })),
        relayers: cfg.relayerDir ?? null,
        paths: {
          db: cfg.dbFile,
          leaves: cfg.leavesDir,
          checkpoints: cfg.checkpointDir,
          state: cfg.stateFile,
          seed: cfg.seedFile,
        },
        http: `${cfg.host}:${cfg.port}${cfg.basePath}`,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

console.log(
  `[indexer] ${cfg.instance}: ${cfg.savanna.id} <-> ${cfg.sources.map((s) => s.chain.id).join(', ')}`,
);

const store = new Store(cfg.dbFile);
const savanna = new SettlementFollower(cfg, store);

/**
 * One follower per source chain, one settlement follower for all of them.
 *
 * The settlement half is what costs something to run — a state-history stream and
 * a tree of nine million leaves — and it is identical whichever chain a crossing
 * came from. So a second source chain is a second log poller, not a second
 * instance, and the deployment stays one container with one database.
 */
const evms = cfg.sources.map((source) => new EvmFollower(cfg, store, source));

/**
 * Each legacy chain's blockroot, for proving its blocks on Telos; one per
 * configured socket. A Savanna chain has none: its relayer keeps its tree.
 */
const keepers = new Map(cfg.antelope.flatMap((a) => (a.keeper ? [[a.chain.id, new BlockrootKeeper(a.keeper)] as const] : [])));

// The API comes up first and stays up. Everything else is allowed to be broken
// while it reports that it is.
const api = createApi({ cfg, store, savanna, evms, keepers, startedAt });
api.listen(cfg.port, cfg.host, () => console.log(`[api] listening on ${cfg.host}:${cfg.port}`));

let stopping = false;

/**
 * Keep a loop alive across failures, backing off so a chain that is down does
 * not turn into a hot retry.
 */
async function supervise(name: string, run: () => Promise<void>): Promise<void> {
  let wait = 2_000;
  while (!stopping) {
    try {
      await run();
      if (stopping) return;
      // A loop that returns without being asked to has nothing more to do this
      // pass. Pause before going round again, or a stream that ends instantly
      // turns into a hot loop that looks like a busy process.
      console.log(`[${name}] returned without being stopped; going round again in 5s`);
      await sleep(5_000);
      wait = 2_000;
    } catch (err) {
      store.incident(name, (err as Error).message);
      console.log(`[${name}] ${(err as Error).message}; restarting in ${wait / 1000}s`);
      await sleep(wait);
      wait = Math.min(wait * 2, 60_000);
    }
  }
}

void supervise('savanna', () => savanna.start());
for (const follower of evms) void supervise(`evm:${follower.id}`, () => follower.start());
for (const [id, keeper] of keepers) void supervise(id, () => keeper.start());

/**
 * The slow pass.
 *
 * The streams are fast and forgetful; the tables are the authority. This is
 * where a burn that happened while the process was down gets its artifact, where
 * a root somebody else submitted gets the block number that makes the cheap
 * track possible, and where the leaf window is trimmed to the deadlines the
 * routes actually carry.
 */
void (async function reconcileLoop() {
  while (!stopping) {
    try {
      const r = await savanna.reconcile();
      // Every source chain's roots at once: the table holds them all, and only
      // the settlement chain can say which block each was taken as of.
      const resolved = await resolveRootBlocks(store, cfg.savanna);
      // Every source chain: a withdrawal released on any of them is a
      // settlement, and asking only the first chain left the other's crossings
      // looking open forever.
      let settled = 0;
      for (const follower of evms) settled += await follower.checkSettled();
      // Deposits already booked need no stored proof; the nonce is spent.
      const dropped = store.dropSpentDepositProofs();
      // Rows the tables could only half-describe, completed from action history.
      const filled = await backfillFromHistory(cfg, store).catch((err: Error) => {
        store.incident('backfill', err.message);
        console.log(`[reconcile] backfill: ${err.message}`);
        return 0;
      });
      if (r.froze || resolved || dropped || settled || filled) {
        console.log(
          `[reconcile] ${r.withdrawals} withdrawals, ${r.deposits} deposits, ` +
            `froze ${r.froze}, resolved ${resolved} root(s), settled ${settled}, ` +
            `dropped ${dropped} spent proof(s), filled ${filled} from history`,
        );
      }
    } catch (err) {
      store.incident('reconcile', (err as Error).message);
      console.log(`[reconcile] ${(err as Error).message}`);
    }
    await sleep(cfg.reconcileMs);
  }
})();

/**
 * What the Antelope chains' relayers carried, read from the files they append
 * beside this process. Its own loop, and a quick one: the file is local and a step of a
 * crossing should show within seconds of the relayer taking it, not on the
 * minute the slow pass happens to come round.
 */
if (cfg.relayerDir && cfg.antelope.length) {
  const dir = cfg.relayerDir;
  const names = cfg.antelope.flatMap((a) => crossingsFiles(a.chain));
  void (async function crossingsLoop() {
    while (!stopping) {
      try {
        const n = ingestCrossings(store, dir, names);
        if (n) console.log(`[crossings] ${n} line(s) from the relayers`);
      } catch (err) {
        store.incident('crossings', (err as Error).message);
        console.log(`[crossings] ${(err as Error).message}`);
      }
      await sleep(cfg.crossingsMs);
    }
  })();
}

/** Sui: the vault's events, for the Sui half of each crossing (services/indexer/suiVault.ts). */
for (const sui of cfg.sui) {
  void (async function suiLoop() {
    while (!stopping) {
      try {
        const n = await followSuiVault(cfg, store, sui);
        if (n) console.log(`[sui] ${n} vault event(s)`);
      } catch (err) {
        store.incident('sui', (err as Error).message);
        console.log(`[sui] ${(err as Error).message}`);
      }
      await sleep(cfg.swapsMs);
    }
  })();
}

if (swapChains(cfg).length) {
  void (async function swapsLoop() {
    while (!stopping) {
      try {
        const n = await followSwaps(cfg, store);
        if (n) console.log(`[swaps] ${n} new bridgeroute action(s)`);
      } catch (err) {
        store.incident('swaps', (err as Error).message);
        console.log(`[swaps] ${(err as Error).message}`);
      }
      await sleep(cfg.swapsMs);
    }
  })();
}

const shutdown = (signal: string) => {
  if (stopping) return;
  stopping = true;
  console.log(`[indexer] ${signal}; stopping`);
  savanna.stop();
  for (const follower of evms) follower.stop();
  for (const keeper of keepers.values()) keeper.stop();
  api.close();
  // The followers write their frontier on the way out; give them a moment, then
  // leave regardless rather than hang a container restart.
  setTimeout(() => {
    store.close();
    process.exit(0);
  }, 3_000).unref();
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms).unref?.());
}
