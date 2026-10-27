/**
 * The Savanna (Antelope/Spring) chains this bridge can settle on.
 *
 * This registry did not exist in the Wire bridge — there the source chain was
 * scattered across `config.ts`, `transport.cjs`, `pack.ts` and two services,
 * which is exactly why a Wire constant could end up governing a Telos digest.
 *
 * The field that matters most is `blockTimestampEpochMs`. Wire counts block
 * timestamps from 2025-01-01, upstream Antelope from 2000-01-01. It lived as a
 * bare constant in `src/proof/pack.ts` and feeds the finality digest, the
 * finality leaf and both proof builders. Using the wrong one yields a slot
 * number off by ~1.6 billion and a digest that is perfectly well-formed and
 * never verifies, with nothing to point at. It is a per-chain fact, so it lives
 * with the chain.
 */

export type FinalizerPolicySource =
  /** Read the active policy from the chain and track diffs in header extension #2. */
  | 'header-extension'
  /** A single finalizer fixed at genesis. Wire only; no rotation ever happens. */
  | 'genesis-constant';

export type SavannaChain = {
  id: string;
  name: string;
  /** Antelope chain id, hex. Signing binds to it, so a wrong one cannot be subtle. */
  chainId: string;
  /**
   * Public endpoints. A deployment's own node goes first through the env
   * (`TELOS_RPC`). The state-history socket is not here at all: `finality_data`
   * is a by-product of *applying* a block and no one serves it publicly, so it is
   * always the operator's own node and always `SHIP_URL`.
   */
  rpc: string[];
  /** Milliseconds per block. 500 on Telos and on Wire. */
  blockIntervalMs: number;
  /** Epoch for block_timestamp slots. See the note above; this is the landmine. */
  blockTimestampEpochMs: number;
  /** `eosio` on Antelope, `sysio` on Wire. */
  systemAccount: string;
  policySource: FinalizerPolicySource;
  /** Bridge contracts. The token contract is baked into the bridge WASM by `on_notify`. */
  accounts: {
    bridge: string;
    token: string;
    lightClient: string;
    gateway: string;
    /**
     * `bridgehop`: a deposit to it goes straight on to another chain, so two
     * source chains meet through this ledger (Ethereum to WAX). Absent where no
     * hop contract is deployed, and then no route runs through it.
     */
    hop?: string;
  };
  /**
   * The extra light client and gateway each additional source chain needs.
   *
   * Keyed by the EVM registry's chain id. The bridge and the token are NOT in
   * here because they are shared: one canonical asset with one route per source
   * chain is the design, so a second chain is a second gateway and a second
   * route, never a second ledger.
   */
  sources?: Record<string, { lightClient: string; gateway: string }>;
  /** Block at which the finality tree's leaves begin. */
  finalityGenesisBlock?: number;
  /** Public archive of block + state-history data, where one exists. */
  archiveUrl?: string;
  /**
   * Hyperion endpoints, tried in order. Where historical actions come from — the
   * proof of possession each `regfinkey` carried, which Telos does not keep.
   */
  history?: string[];
};

const ANTELOPE_EPOCH_MS = 946_684_800_000; // 2000-01-01T00:00:00Z
const WIRE_EPOCH_MS = 1_735_689_600_000; // 2025-01-01T00:00:00Z

/** The old test ledger's accounts on Telos mainnet; see `telos-mainnet` below. */
const BRIDGE_ACCOUNTS = {
  bridge: 'ethbridge111',
  token: 'ethwraptoken',
  lightClient: 'ethlightclnt',
  gateway: 'ethgateway11',
} as const;

/**
 * The production ledger's accounts — the one that holds real balances.
 *
 * A separate set from `ethbridge111`, the old test ledger; the two never share
 * a contract. The production contracts are compiled with these names, and this
 * must name the same accounts.
 *
 * `<chain>.<role>.alcor`, `lc` a light client and `g` a gateway. Only `alcor`
 * can create a name ending in `.alcor` — `newaccount` checks the part after the
 * last dot — so none of these can be registered by anyone else. Further routes
 * follow the same rule and stay within twelve characters: `bsc.lc.alcor`,
 * `bsc.g.alcor`, `pol.lc.alcor`, `pol.g.alcor`, `wax.lc.alcor`, `wax.g.alcor`.
 */
const PRODUCTION_ACCOUNTS = {
  bridge: 'bridge.alcor',
  token: 'wrap.alcor',
  lightClient: 'eth.lc.alcor',
  gateway: 'eth.g.alcor',
  hop: 'hop.alcor',
} as const;

/** Telos mainnet itself, shared by both ledgers that live on it. */
const TELOS_ZERO: Omit<SavannaChain, 'id' | 'name' | 'accounts' | 'sources'> = {
  chainId: '4667b205c6838ef70ff7988f6e8257e8be0e1284a2f59699054a018f743b1d11',
  rpc: ['https://telos.eosusa.io', 'https://telos.greymass.com'],
  history: ['https://mainnet.telos.net', 'https://telos.eosusa.io'],
  blockIntervalMs: 500,
  blockTimestampEpochMs: ANTELOPE_EPOCH_MS,
  systemAccount: 'eosio',
  policySource: 'header-extension',
  // The Savanna transition block, where the tree's leaves start — not the
  // first proper svnn block (480286982); schedule_version is 0x80000000 here.
  finalityGenesisBlock: 480_286_656,
  archiveUrl: 'https://storage.telos.net/mainnet-ship/',
};

export const SAVANNA_CHAINS: Record<string, SavannaChain> = {
  /**
   * Telos mainnet under the old test ledger's accounts, with no routes.
   *
   * Kept only as a name for Telos's own parameters: the relayers and a number
   * of scripts read the chain id, the endpoints and the finality
   * genesis through it. Nothing follows or settles on it any more.
   */
  'telos-mainnet': {
    ...TELOS_ZERO,
    id: 'telos-mainnet',
    name: 'Telos Zero',
    accounts: BRIDGE_ACCOUNTS,
  },

  /**
   * Telos mainnet, the production ledger. Ethereum mainnet is the default pair
   * (`accounts`); BSC and Polygon bring their own.
   */
  'telos-production': {
    ...TELOS_ZERO,
    id: 'telos-production',
    name: 'Telos Zero (production ledger)',
    accounts: PRODUCTION_ACCOUNTS,
    sources: {
      bsc: { lightClient: 'bsc.lc.alcor', gateway: 'bsc.g.alcor' },
      // Prepared 2026-10-07, not deployed: polylightcl verifies Heimdall milestones
      // itself, polygateway falls back to checkpoints through eth.lc.alcor.
      polygon: { lightClient: 'pol.lc.alcor', gateway: 'pol.g.alcor' },
    },
  },

  /**
   * Wire, kept as a registry entry rather than deleted.
   *
   * Nothing here targets it, but it is the only other Savanna chain this code
   * has ever been byte-exact against, and holding its constants next to Telos's
   * is what makes the epoch difference visible instead of implicit.
   */
  wire: {
    id: 'wire',
    name: 'Wire testnet',
    chainId: 'cf4381bcea94e79b2cbb630ca1edd59108b1d159637b2cee7c51d45cdca9c0a7',
    // No public endpoint.
    rpc: [],
    blockIntervalMs: 500,
    blockTimestampEpochMs: WIRE_EPOCH_MS,
    systemAccount: 'sysio',
    policySource: 'genesis-constant',
    accounts: {
      bridge: 'ethbridge',
      token: 'wtoken',
      lightClient: 'ethbridge',
      gateway: 'ethbridge',
    },
  },
};

/**
 * A Savanna chain a `savannalc` follows from another Antelope chain: only what
 * reading its roots and certificates takes, no ledger accounts.
 */
export type FollowedChain = Pick<
  SavannaChain,
  'id' | 'name' | 'chainId' | 'rpc' | 'blockIntervalMs' | 'blockTimestampEpochMs' | 'finalityGenesisBlock'
>;

export const FOLLOWED_CHAINS: Record<string, FollowedChain> = {
  telos: {
    ...TELOS_ZERO,
    id: 'telos',
    name: 'Telos Zero',
  },
  /** Vaulta (formerly EOS). Savanna since 2025. */
  vaulta: {
    id: 'vaulta',
    name: 'Vaulta',
    chainId: 'aca376f206b8fc25a6ed44dbdc66547c36c6c33e3a119ffbeaef943642f0e906',
    rpc: ['https://eos.api.eosnation.io', 'https://api.main.alohaeos.com'],
    blockIntervalMs: 500,
    blockTimestampEpochMs: ANTELOPE_EPOCH_MS,
    // From the snapshot of block 524306748: 128,212,580 leaves through it
    // Our tree starts from that frontier.
    finalityGenesisBlock: 396_094_169,
  },
};

export function followedChain(id: string): FollowedChain {
  const c = FOLLOWED_CHAINS[id];
  if (!c) throw new Error(`unknown followed chain '${id}'. Known: ${Object.keys(FOLLOWED_CHAINS).join(', ')}`);
  return c;
}

/**
 * The settlement chain as the API names it, whichever Telos an instance runs
 * on: `telos`. The registry id (`telos-production`) picks endpoints and accounts
 * and is never shown — a front end matching chains by id has one name for Telos,
 * and so does a relayer reading `/v1/pending`'s `pushOn`.
 */
export const SETTLEMENT_CHAIN = 'telos';

export const ACTIVE_SAVANNA_CHAIN = process.env.SAVANNA_CHAIN ?? 'telos-production';

/**
 * A chain from the registry, with the deployment's `TELOS_RPC` over its
 * endpoints when it is the active one — the way `EXEC_URLS_<chainId>` overrides
 * an EVM chain's. Without it every relayer read and pushed through the public
 * endpoints even with a node on the host: `close` alone asked one every three
 * seconds.
 */
export function savannaChain(id: string = ACTIVE_SAVANNA_CHAIN): SavannaChain {
  const c = SAVANNA_CHAINS[id];
  if (!c) {
    throw new Error(
      `unknown Savanna chain '${id}'. Known: ${Object.keys(SAVANNA_CHAINS).join(', ')}`,
    );
  }
  const rpc = (process.env.TELOS_RPC ?? '').split(',').map((u) => u.trim()).filter(Boolean);
  return id === ACTIVE_SAVANNA_CHAIN && rpc.length ? { ...c, rpc } : c;
}

/** A block_timestamp slot for this chain. Never call this without a chain. */
export function timestampToSlot(chain: SavannaChain, iso: string): number {
  const ms = Date.parse(iso.endsWith('Z') ? iso : `${iso}Z`);
  if (Number.isNaN(ms)) throw new Error(`unparseable timestamp: ${iso}`);
  return Math.floor((ms - chain.blockTimestampEpochMs) / chain.blockIntervalMs);
}
