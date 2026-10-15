/**
 * The EVM networks the bridge can accept deposits from.
 *
 * Carried over from the Wire bridge's `src/chains/registry.ts` with the holes
 * closed: there, the registry existed but `config.ts` shadowed every field with
 * its own env-backed constant, so `CHAIN=mainnet` did not actually switch the
 * bridge. Here the registry is the only source and config derives from it.
 */

export type ProofStrategy =
  /** An L1 with a sync committee: signature + SSZ branches + receipt trie. */
  | 'beacon'
  /** BSC: the consensus header IS the execution header, and finality is a
   *  BEP-126 BLS vote carried in a later header's extraData. No beacon chain,
   *  no SSZ, no committee of 512 — see `src/bsc/`. */
  | 'parlia'
  /**
   * Polygon PoS, verified directly: `polylightcl` reads a milestone out of
   * Heimdall's state under a commit of its validator set, and walks Bor headers
   * down from the milestone's end. Seconds instead of forty minutes, and the
   * checkpoint walk (`checkpoint` below) stays in the gateway for when Polygon
   * changes a format the light client parses. See `docs/POLYGON.md`.
   *
   * Proofs are built live, not frozen: a commit is accepted only from the exact
   * set the light client holds, and Heimdall's set moves about hourly.
   */
  | 'milestone';

export type EvmChain = {
  id: string;
  name: string;
  chainId: number;
  strategy: ProofStrategy;
  exec: string[];
  /**
   * Endpoints that serve `eth_getProof` and old receipts, where `exec` does not.
   *
   * A separate list because the two jobs have nothing in common: following a
   * chain needs a fast endpoint at the head, and proving needs history — and
   * almost every public endpoint serves the first and refuses the second.
   *
   * Absent means `exec` is expected to answer.
   */
  archive?: string[];
  beacon?: string[];
  /** Beacon-chain genesis time, seconds. Wrong value ⇒ the wrong slot ⇒
   *  someone else's block, silently. */
  beaconGenesisTime?: number;
  /**
   * The L1 a Polygon checkpoint lands on: the chain whose light client proves the
   * checkpoint fallback (`creditcp`).
   */
  settlesTo?: string;

  /**
   * Blocks per epoch, for `parlia` chains: where a validator set is announced.
   *
   * 1000 today, and it has been 200 and 500 before, so it belongs here rather
   * than in a constant. A wrong value does not mis-verify anything — the keys
   * would not hash to a recorded set — it just fails to find the right epoch.
   */
  epochLength?: number;

  /**
   * Heimdall, for a `milestone` chain whose milestones Telos verifies itself
   * (`polylightcl`): CometBFT RPC (commits, validators, state proofs) and the
   * REST gateway (milestones by number). `chainId` is signed into every vote.
   */
  heimdall?: {
    chainId: string;
    comet: string[];
    rest: string[];
  };
  /**
   * Checkpoint parameters for Polygon's fallback path, derived rather than copied.
   *
   * `rootChain` comes from Heimdall's own `chainmanager/params`, and
   * `headerBlocksSlot` was found by computing `keccak(id ‖ slot)` for each
   * candidate until the storage there held a checkpoint root already known from
   * `headerBlocks()`. Both were then confirmed by rebuilding a 256-block
   * checkpoint from Bor headers and matching the root on chain.
   */
  checkpoint?: {
    rootChain: string;
    /** Storage slot of the `headerBlocks` mapping. */
    headerBlocksSlot: number;
  };

  vault?: string;
  lightClient?: string;
  withdrawals?: string;
  /** Native ETH is the zero address: the one address no ERC-20 can occupy. */
  nativeToken: string;
  nativeSymbol: string;
  blockTime: number;
  confirmations: number;
};

/**
 * keccak("Deposit(address,address,uint256,uint64,uint64,uint64,address,uint64,uint64,bytes)").
 *
 * The raw uint256 travels alongside the canonical uint64 it was normalized to, so
 * Telos can cross-check the scale rather than trust it; then where a deposit that
 * cannot be delivered goes back, the depositor's terms for a solver, and the memo
 * last, the one dynamic field. Every change to the event is a change to this
 * topic, and to `DEPOSIT_TOPIC0` in the contracts that verify it.
 */
export const DEPOSIT_TOPIC =
  '0x13b5e8bb47a4ed47ba8b8a0cc1a517faa77d886adcf4b02e4fe0c014712a936f';

export const EVM_CHAINS: Record<string, EvmChain> = {
  mainnet: {
    id: 'mainnet',
    name: 'Ethereum',
    chainId: 1,
    // No archive endpoint recorded: the one that worked was Blast API's, which
    // is shutting down and redirecting to Alchemy. Nothing here proves state
    // against Ethereum mainnet yet, so leaving this empty is honest rather than
    // leaving a host that will start refusing.

    strategy: 'beacon',
    exec: ['https://ethereum-rpc.publicnode.com'],
    beacon: ['https://ethereum-beacon-api.publicnode.com'],
    // The chain's `genesis_time`, as publicnode and Lodestar both serve it —
    // not MIN_GENESIS_TIME (1_606_824_000), which it trails by 23 seconds.
    beaconGenesisTime: 1_606_824_023,
    // The production set, deployed 2026-09-29 against bridge.alcor.
    vault: '0x3e447d533321ad6a8412f97034ac295a9ff8d858',
    lightClient: '0xd8f46a549747ab690eeeef0c327e42060cbb3b00',
    withdrawals: '0x04fb700b93eb68cadd88d8e8d4dfe4857d5cb3c6',
    nativeToken: '0x0000000000000000000000000000000000000000',
    nativeSymbol: 'ETH',
    blockTime: 12,
    confirmations: 12,
  },

  bsc: {
    id: 'bsc',
    name: 'BNB Smart Chain',
    chainId: 56,
    strategy: 'parlia',
    exec: ['https://bsc-rpc.publicnode.com', 'https://bsc-dataseed1.binance.org'],
    epochLength: 1000,
    // The free list cannot carry the route: publicnode refuses any receipt but
    // the newest with 403, the Binance seeds refuse eth_getLogs. Production sets
    // `EXEC_URLS_56` and `ARCHIVE_URLS_56` to a paid endpoint (Alchemy, with its
    // key, in .env); these are the fallback behind it.
    //
    // Deployed 2026-10-03.
    vault: '0x53f18eaa8bf8099b5ba21bb7e11ed311b677690e',
    lightClient: '0x4b956b92c8aedc1f3f47243396ed53828c163b46',
    withdrawals: '0x6132b4d02e02f1b378f0fc67c3d4f553eb76acb5',
    nativeToken: '0x0000000000000000000000000000000000000000',
    nativeSymbol: 'BNB',
    blockTime: 0.45,
    confirmations: 0,
  },

  polygon: {
    id: 'polygon',
    name: 'Polygon PoS',
    chainId: 137,
    strategy: 'milestone',
    settlesTo: 'mainnet',
    exec: ['https://polygon-bor-rpc.publicnode.com', 'https://polygon-rpc.com'],
    // Verified 2026-10-07: a stored
    // milestone, its ICS23 proofs to app_hash, the header hash and > 2/3 of
    // precommits recovering over keccak256.
    heimdall: {
      chainId: 'heimdallv2-137',
      // publicnode second: an independent operator, used to cross-check a
      // bootstrap and as a fallback. It prunes state after ~5000 heights (~1.7 h)
      // where Polygon's own keeps over 100,000, so a late proof needs the first.
      comet: ['https://tendermint-api.polygon.technology', 'https://polygon-heimdall-rpc.publicnode.com'],
      rest: ['https://heimdall-api.polygon.technology', 'https://polygon-heimdall-rest.publicnode.com'],
    },
    // Derived 2026-09-22 from Heimdall's chainmanager/params, then verified by
    // rebuilding checkpoint 1121680000 (256 blocks) from Bor headers: the tree
    // matched the root stored on Ethereum exactly.
    checkpoint: {
      rootChain: '0x86e4dc95c7fbdbf52e33d563bbdb00823894c287',
      headerBlocksSlot: 5,
    },
    // Deployed 2026-10-07.
    vault: '0x15bbd21148f98c4daeb30450eb05666f7859993d',
    lightClient: '0x38f3118ca7e2bfe9e1c1b8d15071fb47cdbae3dd',
    withdrawals: '0xb0510e20f12f88cbc63b9a5d8ae3e052a7153fb8',
    nativeToken: '0x0000000000000000000000000000000000000000',
    nativeSymbol: 'POL',
    // 1.5 s, measured over 500 blocks 2026-09-22. Was 2 here, which is what Bor
    // ran before the Rio upgrade shortened it.
    blockTime: 1.5,
    confirmations: 0,
  },
};

export const ACTIVE_EVM_CHAIN = process.env.CHAIN ?? 'mainnet';

/** A chain from the registry, with the deployment's endpoint overrides applied. */
export function evmChain(id: string = ACTIVE_EVM_CHAIN): EvmChain {
  const c = EVM_CHAINS[id];
  if (!c) {
    throw new Error(`unknown EVM chain '${id}'. Known: ${Object.keys(EVM_CHAINS).join(', ')}`);
  }

  // A paid endpoint carries a key, and a key does not belong in a file that is
  // committed. `EXEC_URLS_<chainId>` and `ARCHIVE_URLS_<chainId>` override the
  // registry the same way `EVM_FROM_BLOCK_<chainId>` already does, so the
  // registry records what a chain needs while the deployment says where it is —
  // and every process reading this chain, follower or relayer, sees the same.
  const urlsOf = (name: string) =>
    (process.env[`${name}_${c.chainId}`] ?? '').split(',').map((u) => u.trim()).filter(Boolean);
  const exec = urlsOf('EXEC_URLS');
  const archive = urlsOf('ARCHIVE_URLS');
  return {
    ...c,
    ...(exec.length ? { exec } : {}),
    ...(archive.length ? { archive } : {}),
  };
}
