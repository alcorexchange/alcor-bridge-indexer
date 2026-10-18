/**
 * One instance's configuration.
 *
 * An instance is one Savanna settlement chain and the source chains it follows:
 * every EVM chain the settlement registry declares a light client for, and each
 * Antelope chain (WAX, XPR, Vaulta) turned on in the environment
 * (src/chains/antelope.ts). One container per settlement chain, and nothing here
 * knows which one it is running.
 *
 * Nothing in this file holds a network fact of its own. Endpoints, contract
 * accounts, block intervals and genesis times all come from `src/chains/*` by
 * way of `src/config.ts`, which is the only place allowed to read them. The
 * predecessor's config shadowed its registry and the result was that switching
 * chains did not switch the bridge — so what is left here is strictly about this
 * process: where it keeps files, what port it answers on, how much it retains.
 */

import {
  EVM,
  SAVANNA,
  SHIP_URL,
  TELOS_RPC,
  BEACON_URLS,
  EXEC_URLS,
  ACCOUNTS,
  TELOS_HISTORY,
} from '../../src/config.ts';
import type { SavannaChain } from '../../src/chains/savanna.ts';
import { EVM_CHAINS, type EvmChain, evmChain } from '../../src/chains/evm.ts';
import { ANTELOPE_CHAINS, antelopeByDomain, enabledBy, type AntelopeChain } from '../../src/chains/antelope.ts';
import { SUI_CHAINS, suiByDomain, type SuiChain } from '../../src/chains/sui.ts';
import { NEAR_CHAINS, nearByDomain, type NearChain } from '../../src/chains/near.ts';
import type { KeeperConfig } from './blockroot.ts';

const num = (v: string | undefined, fallback: number) => (v === undefined ? fallback : Number(v));

/** `telos`: defined beside the registry, so a relayer reading the API matches it without loading this config. */
export { SETTLEMENT_CHAIN } from '../../src/chains/savanna.ts';

/** An EVM chain this instance follows, the accounts that verify it on Telos, and the endpoints it is read through. */
export type Source = {
  chain: EvmChain;
  accounts: { lightClient: string; gateway: string };
  /**
   * Resolved once: `EXEC_URLS` for the instance's own chain, the registry's
   * (with any `EXEC_URLS_<chainId>`) for every other. A deployment naming its
   * own node means its own node for that chain, and applying it to a second
   * chain would point one chain's reads at the other's nodes.
   */
  exec: string[];
};

/** An Antelope chain this instance follows, and where it reads it. */
/** Sui, on when `SUI_GRAPHQL` names its GraphQL endpoints (comma-separated). */
export type SuiConfig = { chain: SuiChain; graphql: string[] };

/**
 * NEAR, on when `<PREFIX>_RPC` names its JSON-RPC endpoints (comma-separated):
 * `NEAR_RPC` for mainnet, `NEAR_TESTNET_RPC` for testnet. `<PREFIX>_TX_API` is
 * FastNEAR's account-history API, which only finds the vault's transactions —
 * what they say is read from the RPC.
 */
export type NearConfig = { chain: NearChain; rpc: string[]; txApi: string };

export type AntelopeConfig = {
  chain: AntelopeChain;
  /** The chain's HTTP API, for the vault's own tables (what it settled) and the status page. */
  rpc: string;
  /** Hyperion, for the vault's past actions when a row is missing the chain's half. */
  history: string[];
  /** Its blockroot keeper: a legacy chain only, since a Savanna one signs over nothing a keeper holds. */
  keeper?: KeeperConfig;
};

export type IndexerConfig = {
  /** Names this instance in logs and in `/health`. */
  instance: string;
  savanna: SavannaChain;
  evm: EvmChain;
  /**
   * Every source chain this instance follows, resolved once.
   *
   * The settlement half is shared and the source half is not, so this is the list
   * the followers, the reconciler and `/v1/chains` all walk. Computing it in three
   * places was how the `seen` reconciliation ended up reading one domain's scope
   * and marking every chain's deposits from it.
   */
  sources: Source[];

  /**
   * Who the served proofs name as their payer.
   *
   * A proof's actions take a payer as an argument and `require_auth` it, so the
   * signature has to match whoever is named. Baking the contract accounts in there
   * meant that closing a crossing needed the bridge key — the one that can replace
   * the code of the contract that mints — and that key has no business on a server.
   * Naming a dedicated account instead makes the whole queue pushable by a key
   * whose worst case is paying for proofs that are verified anyway.
   *
   * Unset keeps the old behaviour: the light client and the gateway pay for
   * themselves.
   */
  proofPayer?: string;

  /**
   * The Antelope contracts this instance pushes to.
   *
   * Resolved for this instance's EVM chain: the bridge and the token are shared,
   * the light client and the gateway are not. Reading them off `savanna.accounts`
   * gave every instance the Ethereum pair, which for a BSC instance is a proof
   * offered against a client that has never heard of the block.
   */
  accounts: { bridge: string; token: string; lightClient: string; gateway: string };
  ship: string;
  /** Hyperion, for the proofs of possession behind `/v1/finalizer-keys`. */
  history: string[];
  beaconUrls: string[];

  dbFile: string;
  leavesDir: string;
  checkpointDir: string;
  stateFile: string;
  seedFile: string;

  host: string;
  port: number;
  /**
   * Path every route hangs off, so this can share a hostname with the chain API.
   *
   * The service serves the prefix itself rather than having a proxy strip it,
   * which means the paths in a log, in this README and in a browser are the same
   * string. A proxy that rewrites is a proxy you have to remember about at three
   * in the morning. Empty means no prefix.
   */
  basePath: string;

  /** Leaves between frontier checkpoints. One costs about a kilobyte. */
  checkpointEvery: number;
  /**
   * Leaves between dropping the tree's interior nodes.
   *
   * `IncrementalTree` remembers every node it forms so that a branch can be
   * walked afterwards, and a process that runs for a year cannot keep them all:
   * a root is computed once per block, and each one adds a handful of entries.
   * Artifacts are frozen within a block or two of the burn, so nothing needs a
   * branch older than that, and forgetting on this cadence bounds the memory at
   * a few tens of megabytes.
   */
  forgetEvery: number;
  /**
   * How much of the leaf window to keep, as a multiple of the longest route's
   * `withdraw_ttl`.
   *
   * The window exists for one purpose: re-branching an old burn onto a root that
   * is already trusted on Ethereum, which is the 135k-gas path instead of the
   * ~2.6M one. Past its deadline a withdrawal can only be expired, and `expire`
   * needs the same proof — so the window is sized by the deadline and then some,
   * not by the node's own retention.
   */
  leafWindowFactor: number;
  /** Floor under that, for a chain whose routes have no deadline set yet. */
  leafWindowMinDays: number;

  /** How often to ask the EVM node for new logs. */
  evmPollMs: number;
  /** Where to start scanning EVM logs when there is no saved position. */
  evmFromBlock: number;
  /**
   * Longest `parent_root` chain worth building, in headers.
   *
   * A finalized proof links the log's block up to a finalized header, and that
   * chain grows by one 112-byte header every twelve seconds of age. Antelope
   * allows 600 KB per transaction and the committee blob already takes ~49 KB,
   * so past roughly five thousand headers the proof stops fitting at all. That
   * is the deposit side's deadline — about sixteen hours, much tighter than the
   * withdrawal side's eight days.
   */
  maxAncestry: number;

  /**
   * Leaves between checking a computed root against the chain's own opinion.
   *
   * Under Savanna a block header's `action_mroot` carries the finality tree root
   * as of the block its certificate claims — so every block is a producer-signed
   * assertion about a root this process just computed. An error anywhere
   * propagates into every later root, so an occasional check is enough to catch
   * one, and without any the first sign of a divergence is a proof the far chain
   * rejects.
   */
  verifyEvery: number;

  /** How often to reconcile stored state against both chains' own tables. */
  reconcileMs: number;

  /** The Antelope chains this instance follows: `<PREFIX>_SHIP_URL` for a legacy one, `<PREFIX>_RPC` for a Savanna one. */
  antelope: AntelopeConfig[];
  /** The Sui chains this instance shows (`<PREFIX>_GRAPHQL`); their deposits are the Sui relayer's. */
  sui: SuiConfig[];
  /** The NEAR chains this instance shows (`<PREFIX>_RPC`); their deposits are the NEAR relayer's. */
  near: NearConfig[];
  /** Where those chains' relayers append their crossings, when they run beside this process. */
  relayerDir?: string;
  /** How often those files are read: a stat and a short read, so every 200 ms. */
  crossingsMs: number;
  /** Between reads of bridgeroute's history on each chain it is deployed on. */
  swapsMs: number;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): IndexerConfig {
  const dataDir = env.DATA_DIR ?? 'data';
  if (!SHIP_URL) {
    throw new Error(
      `no state-history socket for '${SAVANNA.id}': set SHIP_URL to your node's ` +
        `state_history_plugin endpoint — the indexer cannot follow a chain it cannot stream.`,
    );
  }

  return {
    instance: env.INSTANCE ?? `${SAVANNA.id}-${EVM.id}`,
    // The registry's endpoints unless the deployment names its own. `TELOS_RPC`
    // was declared in config.ts and read by nothing, so an instance running
    // beside its own node still went out to public endpoints for every header.
    // Overriding here means every Antelope call this process makes follows it.
    savanna: { ...SAVANNA, rpc: TELOS_RPC },
    evm: EVM,
    accounts: ACCOUNTS,
    sources: sourceChains(),
    proofPayer: env.PROOF_PAYER,
    ship: SHIP_URL,
    history: TELOS_HISTORY,
    beaconUrls: BEACON_URLS,

    dbFile: env.DB_FILE ?? `${dataDir}/indexer.sqlite`,
    leavesDir: env.LEAVES_DIR ?? `${dataDir}/leaves`,
    checkpointDir: env.CHECKPOINT_DIR ?? `${dataDir}/checkpoints`,
    stateFile: env.TREE_STATE ?? `${dataDir}/tree-state.json`,
    seedFile: env.TREE_SEED ?? 'data/tree-seed.json',

    host: env.HOST ?? '0.0.0.0',
    port: num(env.PORT, 8899),
    basePath: normalizeBasePath(env.API_BASE_PATH ?? '/api'),

    checkpointEvery: num(env.CHECKPOINT_EVERY, 50_000),
    forgetEvery: num(env.FORGET_EVERY, 10_000),
    leafWindowFactor: num(env.LEAF_WINDOW_FACTOR, 2),
    leafWindowMinDays: num(env.LEAF_WINDOW_MIN_DAYS, 30),

    evmPollMs: num(env.EVM_POLL_MS, 12_000),
    evmFromBlock: num(env.EVM_FROM_BLOCK, 0),
    maxAncestry: num(env.MAX_ANCESTRY, 4_096),

    verifyEvery: num(env.VERIFY_EVERY, 20_000),
    reconcileMs: num(env.RECONCILE_MS, 60_000),

    /** Where the Antelope chains' relayers append their crossings (their PROOFS_DIR parent), if beside this process. */
    relayerDir: env.RELAYER_DIR,
    // An idle look is a stat of a few local files, and a deposit is in its file
    // the moment the relayer sees its block: the poll is the only wait left.
    crossingsMs: num(env.CROSSINGS_MS, 200),
    swapsMs: num(env.SWAPS_MS, 10_000),
    antelope: antelopeChains(env, dataDir),
    sui: suiChains(env),
    near: nearChains(env),
  };
}

export function suiChains(env: NodeJS.ProcessEnv): SuiConfig[] {
  return SUI_CHAINS.filter((c) => env[`${c.env}_GRAPHQL`]).map((c) => ({
    chain: c,
    graphql: env[`${c.env}_GRAPHQL`]!.split(',').map((s) => s.trim()).filter(Boolean),
  }));
}

export function nearChains(env: NodeJS.ProcessEnv): NearConfig[] {
  return NEAR_CHAINS.filter((c) => env[`${c.env}_RPC`]).map((c) => ({
    chain: c,
    rpc: env[`${c.env}_RPC`]!.split(',').map((s) => s.trim()).filter(Boolean),
    txApi: (env[`${c.env}_TX_API`] ?? c.defaults.txApi).replace(/\/$/, ''),
  }));
}

/** The Antelope chains the environment turns on, each with its settings read under its prefix. */
export function antelopeChains(env: NodeJS.ProcessEnv, dataDir: string): AntelopeConfig[] {
  return ANTELOPE_CHAINS.filter((c) => env[enabledBy(c)]).map((c) => antelopeConfig(c, env, dataDir));
}

function antelopeConfig(c: AntelopeChain, env: NodeJS.ProcessEnv, dataDir: string): AntelopeConfig {
  const history = (env[`${c.env}_HISTORY`]?.split(',') ?? c.defaults.history).map((s) => s.trim()).filter(Boolean);
  if (c.consensus === 'savanna') return { chain: c, rpc: env[`${c.env}_RPC`]!, history };
  return {
    chain: c,
    rpc: env[`${c.env}_RPC`] ?? c.defaults.rpc,
    history,
    keeper: {
      chain: c,
      ship: env[`${c.env}_SHIP_URL`]!,
      seedFile: env[`${c.env}_BLOCKROOT_SEED`] ?? c.defaults.seedFile,
      dir: env[`${c.env}_DIR`] ?? `${dataDir}/${c.id}`,
      checkpointEvery: num(env[`${c.env}_CHECKPOINT_EVERY`], 10_000),
    },
  };
}

/** `/api`, `api/`, `/api/` and `api` all mean the same thing; `/` and `` mean none. */
function normalizeBasePath(raw: string): string {
  const trimmed = raw.trim().replace(/^\/+|\/+$/g, '');
  return trimmed ? `/${trimmed}` : '';
}

/** Blocks of leaf hashes to keep, from the deadlines the routes actually carry. */
export function leafWindowBlocks(cfg: IndexerConfig, longestTtlSeconds: number): number {
  const seconds = Math.max(
    longestTtlSeconds * cfg.leafWindowFactor,
    cfg.leafWindowMinDays * 86_400,
  );
  return Math.ceil((seconds * 1000) / cfg.savanna.blockIntervalMs);
}

/**
 * The instance's own EVM chain first, then every other chain the settlement
 * registry declares a light client for.
 *
 * Own-chain first on purpose: it is the one whose endpoints `EXEC_URLS` may
 * override and the one whose beacon endpoints exist, so anything that still
 * assumes a single chain keeps meaning the same one it used to.
 */
function sourceChains(): Source[] {
  const out: Source[] = [
    { chain: EVM, accounts: { lightClient: ACCOUNTS.lightClient, gateway: ACCOUNTS.gateway }, exec: EXEC_URLS },
  ];
  for (const [id, accounts] of Object.entries(SAVANNA.sources ?? {})) {
    if (id === EVM.id) continue;
    // Through `evmChain` rather than the raw registry, so the `EXEC_URLS_*` and
    // `ARCHIVE_URLS_*` overrides reach the follower.
    const chain = EVM_CHAINS[id] ? evmChain(id) : undefined;
    // A route prepared on Telos before its vault exists — Polygon mainnet, from
    // 2026-10-07 — has nothing to follow yet, and a follower with no vault would
    // ask for logs from no address, which is every log on the chain.
    if (chain && !chain.vault) {
      console.log(`[config] ${id}: no vault in the registry yet — not followed`);
      continue;
    }
    if (chain) out.push({ chain, accounts, exec: chain.exec });
  }
  return out;
}

/**
 * What a ledger domain names: an EVM chain this instance follows, with its
 * accounts and endpoints, or an Antelope chain, Sui or NEAR from the registry. Undefined for
 * a domain that is neither — an EVM chain nobody here follows, or a malformed
 * one — which every caller has to answer for rather than guess at.
 *
 * The one place a domain is classified. Telling the two kinds apart by whether
 * the domain parses as a small number was spread over a dozen call sites, each
 * with its own idea of what null and an unfollowed chain meant.
 */
export type Domain = ({ kind: 'evm' } & Source) | { kind: 'antelope'; chain: AntelopeChain } | { kind: 'sui'; chain: SuiChain } | { kind: 'near'; chain: NearChain };

export function chainOfDomain(cfg: IndexerConfig, domain: string | number | null | undefined): Domain | undefined {
  if (domain === null || domain === undefined) return undefined;
  const far = antelopeByDomain(String(domain));
  if (far) return { kind: 'antelope', chain: far };
  const sui = suiByDomain(String(domain));
  if (sui) return { kind: 'sui', chain: sui };
  const near = nearByDomain(String(domain));
  if (near) return { kind: 'near', chain: near };
  const source = cfg.sources.find((s) => String(s.chain.chainId) === String(domain));
  return source && { kind: 'evm', ...source };
}
