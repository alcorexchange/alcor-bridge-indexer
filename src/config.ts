/**
 * Runtime configuration, derived from the chain registries.
 *
 * The predecessor had a `config.ts` that *shadowed* its registry: every endpoint,
 * the vault address and the deposit topic existed twice, once in the registry and
 * once here backed by an env var, and almost all the code read this file. The
 * result was that switching `CHAIN` did not actually switch the bridge, and three
 * different vault addresses lived in the tree at once.
 *
 * So nothing here holds a network fact of its own. Everything comes from
 * `src/chains/*`, and an env var may only override what the registry already
 * declares.
 */

import { evmChain, ACTIVE_EVM_CHAIN } from './chains/evm.ts';
import { savannaChain, ACTIVE_SAVANNA_CHAIN } from './chains/savanna.ts';

export const EVM = evmChain(ACTIVE_EVM_CHAIN);
export const SAVANNA = savannaChain(ACTIVE_SAVANNA_CHAIN);

const list = (v: string | undefined, fallback: string[]) =>
  v ? v.split(',').map((s) => s.trim()).filter(Boolean) : fallback;

/**
 * Beacon endpoints, tried in order.
 *
 * More than one because the distinction that matters is "this host does not have
 * the block" versus "this host is down", and only a second opinion tells them
 * apart.
 */
export const BEACON_URLS = list(process.env.BEACON_URLS, EVM.beacon ?? []);

/**
 * Execution endpoints, tried in order.
 *
 * Order is deliberate: a node with generous retention goes first. Public nodes
 * prune receipts within days and then answer `eth_getTransactionReceipt` with
 * `null`, which reads exactly like "no such deposit" — so `null` has to count as
 * no answer rather than as a fact, and there has to be somewhere else to ask.
 */
export const EXEC_URLS = list(process.env.EXEC_URLS, EVM.exec);

/** Beacon genesis, seconds. Wrong value means the wrong slot, silently. */
export const BEACON_GENESIS_TIME = Number(
  process.env.BEACON_GENESIS_TIME ?? EVM.beaconGenesisTime,
);

/** Seconds per beacon slot. Twelve on every network this supports. */
export const SLOT_SECONDS = 12;

/** How deep an optimistic deposit must be before it is offered for proving. */
export const CONFIRMATIONS = Number(process.env.CONFIRMATIONS ?? EVM.confirmations);

/** Head-signature cache depth, in slots. 900 is about three hours. */
export const CACHE_SLOTS = Number(process.env.CACHE_SLOTS ?? 900);
export const CACHE_FILE = process.env.CACHE_FILE ?? '/data/head-cache.json';

/** Telos RPC, and the state-history socket of the operator's own node (no registry default). */
export const TELOS_RPC = list(process.env.TELOS_RPC, SAVANNA.rpc);
export const SHIP_URL = process.env.SHIP_URL;
/** Hyperion, for actions Telos no longer holds in state. */
export const TELOS_HISTORY = list(process.env.TELOS_HISTORY, SAVANNA.history ?? []);

/**
 * The contract accounts this run talks to.
 *
 * The bridge and the token are shared by every source chain — one canonical asset
 * with one route per chain — while the light client and the gateway are per chain,
 * because each verifies a different consensus. So `CHAIN` picks them the same way
 * it picks endpoints, and a BSC run cannot accidentally address the Ethereum
 * client: it would find no header there and fail, which is the good case. The bad
 * case is the deposit that silently never arrives.
 */
export const ACCOUNTS = {
  ...SAVANNA.accounts,
  ...(SAVANNA.sources?.[EVM.id] ?? {}),
};

/**
 * Only a beacon chain owes a genesis time.
 *
 * A Parlia chain has no beacon chain at all — its consensus header is its
 * execution header — so there is no such fact to supply, and demanding one made
 * every BSC script fail at import with a question about Ethereum.
 */
if (EVM.strategy === 'beacon' && !BEACON_GENESIS_TIME) {
  throw new Error(
    `no beacon genesis time for '${EVM.id}'. Add it to the registry rather than ` +
      `passing BEACON_GENESIS_TIME — it is a fact about the network, not about this run.`,
  );
}
