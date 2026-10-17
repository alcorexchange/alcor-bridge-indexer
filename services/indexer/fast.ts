/**
 * The fast deposit proof, built when it is asked for rather than stored.
 *
 * The committee signs a head about twelve seconds after the block exists, while
 * finality is two epochs behind — roughly thirteen minutes. Both are real
 * proofs; they differ in what they claim. A finalized one says the chain can no
 * longer abandon this block. An optimistic one says the committee saw it and
 * `K` blocks were built on top, which is what an exchange means by
 * confirmations, and it is checked on chain rather than asserted: the proof
 * carries the `parent_root` chain and the contract hashes the links itself.
 *
 * ## Why this is not frozen like the other half
 *
 * An optimistic bundle bakes in its depth. One built at twelve confirmations is
 * worthless the moment a route raises `min_confirmations` to twenty, and there
 * is no way to deepen it afterwards — the ancestry is part of what was signed.
 * So the durable copy is finalized, and this one is built to the route's limits
 * as they stand at the moment somebody asks.
 *
 * That is the whole division: **store what cannot go stale, serve what must be
 * current.**
 *
 * ## What the route decides
 *
 * Three numbers on chain, and all three are checked again by the gateway, so
 * offering a proof that breaks one of them only wastes a transaction:
 *
 *   optimistic_max      the largest amount an unfinalized proof may credit;
 *                       zero means finalized proofs only, and is the default
 *   min_confirmations   how deep the block must be PROVED to be
 *   optimistic_ttl      how long a proved unfinalized root stays usable, which
 *                       is the gateway's business and not checked here
 */

import type { IndexerConfig } from './config.ts';
import type { RouteRoom } from './holds.ts';

import { BEACON_GENESIS_TIME } from '../../src/config.ts';
import { humanEta } from '../../src/chains/eta.ts';
import { execRpc, execHead } from '../../src/evm/exec.ts';
import { BeaconClient } from '../../src/evm/beacon.ts';
import { updateFromBlocks, slotForTimestamp, ancestryOfLength } from '../../src/evm/fromBlocks.ts';
import { buildOptimisticBundle } from '../../src/evm/proofBundle.ts';
import { proverootArgs, creditArgs } from '../../src/proofs.ts';
import { getTableRows } from '../../src/net/antelope.ts';

export type RouteLimits = {
  id: number;
  optimisticMax: bigint;
  minConfirmations: number;
  depositsOpen: boolean;
};

/**
 * Routes and assets as the bridge contract lists them.
 *
 * Held briefly rather than read per request: they change by an owner action, a
 * poll every request would be a poll per page view, and a minute of staleness
 * cannot make an offered proof invalid — the gateway checks all of it again.
 *
 * A minute is also how long a brand-new listing takes to become visible here,
 * which is the whole of what "picking up a new token" requires. Nothing is
 * compiled in and nothing is restarted.
 */
let listingCache: { at: number; routes: any[]; assets: any[]; spokes: Set<string> } | null = null;

async function listings(cfg: IndexerConfig) {
  if (!listingCache || Date.now() - listingCache.at > 60_000) {
    const [routes, assets, spokes] = await Promise.all([
      getTableRows(cfg.savanna, { code: cfg.savanna.accounts.bridge, table: 'routes' }),
      getTableRows(cfg.savanna, { code: cfg.savanna.accounts.bridge, table: 'assets' }),
      getTableRows<{ route_id: number | string }>(cfg.savanna, { code: cfg.savanna.accounts.bridge, table: 'spokes' }),
    ]);
    listingCache = { at: Date.now(), routes, assets, spokes: new Set(spokes.map((r) => String(r.route_id))) };
  }
  return listingCache;
}

const SECONDS_PER_SLOT = 12;

/**
 * The oldest signature the light client takes in an optimistic proof, from its
 * `clock` row. Zero while the row is unset: the contract refuses every
 * optimistic proof then, so none is offered.
 */
async function signatureMaxAge(cfg: IndexerConfig): Promise<number> {
  const [row] = await getTableRows(cfg.savanna, { code: cfg.accounts.lightClient, table: 'clock' });
  return row ? Number(row.max_age_seconds) : 0;
}

/** Load the listings so the synchronous lookups below can answer. */
export const warmListings = (cfg: IndexerConfig) => listings(cfg).then(() => undefined);

const bare = (a: string) => a.replace(/^0x/, '').toLowerCase();

/**
 * The bridge's route for one token on one chain.
 *
 * `domain` is a parameter and has no default, which it used to: the filter read
 * `cfg.evm.chainId`, this instance's OWN chain. That was right while an instance
 * followed one chain and silently wrong afterwards — a token on any other domain
 * matched nothing, so `routeFor` returned undefined for every BSC and Polygon
 * deposit. The visible damage was a queue that told those depositors their
 * route "accepts finalized proofs only" and an API that reported their symbol
 * and precision as null; the invisible damage was that the fast path could never
 * be offered to them at all.
 *
 * A token address is not unique across chains either — the same ERC-20 bytecode
 * deploys to the same address on several — so the domain is what makes this a
 * lookup rather than a guess.
 */
function routeRow(extToken: string, domain: string): any | undefined {
  const want = bare(extToken);
  return listingCache?.routes.find(
    (r) => String(r.ext_token).toLowerCase() === want && String(r.domain) === domain,
  );
}

export async function routeFor(
  cfg: IndexerConfig,
  extToken: string,
  domain: string,
): Promise<RouteLimits | undefined> {
  await listings(cfg);
  return routeLimits(extToken, domain);
}

/** `routeFor` from the listings already loaded, for code that renders rows; undefined before they are. */
export function routeLimits(extToken: string | null, domain: string | null): RouteLimits | undefined {
  if (!extToken || domain === null) return undefined;
  const row = routeRow(extToken, domain);
  if (!row) return undefined;
  return {
    id: Number(row.id),
    optimisticMax: BigInt(row.optimistic_max),
    minConfirmations: Number(row.min_confirmations),
    depositsOpen: Boolean(row.deposits_open),
  };
}

/** What a route allows right now (see `holds.ts`), from the listings already loaded. */
export function routeRoom(extToken: string | null, domain: string | null): RouteRoom | undefined {
  if (!extToken || domain === null) return undefined;
  const row = routeRow(extToken, domain);
  if (!row) return undefined;
  return {
    cap: BigInt(row.cap),
    backing: BigInt(row.backing),
    maxWithdrawal: BigInt(row.max_withdrawal),
    spoke: listingCache!.spokes.has(String(row.id)),
  };
}

/**
 * What a token's canonical amounts are denominated in.
 *
 * Without it an amount is a bare integer, and `1000000` is 0.01 ETH on one route
 * and 1.0 ATUSD on another. One asset hid that; two made it a defect. The
 * precision lives in the symbol the bridge issues (`8,ETH`), which is reachable
 * from the route by `asset_id` — the symbol code as a raw uint64.
 *
 * Synchronous on purpose: it is called per row while rendering a list, and the
 * listings are warmed once per request.
 */
export function assetFor(
  extToken: string | null,
  domain: string | null,
): { symbol: string; precision: number } | undefined {
  if (!extToken || domain === null || !listingCache) return undefined;
  const route = routeRow(extToken, domain);
  return route && assetOfRoute(listingCache.assets, route);
}

/**
 * The asset a ledger route carries, from the ledger's `assets` table: the route
 * names it by `asset_id`, the symbol code's raw value, and `8,ETH` is ETH at
 * precision 8. Matching on the string was a placeholder that matched whatever
 * came first.
 */
export function assetOfRoute(
  assets: { sym: unknown }[],
  route: { asset_id: unknown },
): { symbol: string; precision: number } | undefined {
  const asset = assets.find((a) => symbolCodeRaw(String(a.sym)) === String(route.asset_id));
  if (!asset) return undefined;
  const [precision, symbol] = String(asset.sym).split(',');
  return { symbol, precision: Number(precision) };
}

/**
 * `"8,ETH"` -> the uint64 the table keys assets by, as a decimal string.
 *
 * `symbol_code::raw()`, which packs the characters back to front and stops —
 * no trailing shift. That belongs to `symbol::raw()`, which carries precision in
 * the low byte, and using the wrong one gives a number that matches nothing.
 * Checked against the live table: ATUSD is 293455877185, ETH is 4740165.
 */
export function symbolCodeRaw(sym: string): string {
  const code = sym.split(',')[1] ?? '';
  let raw = 0n;
  for (let i = code.length - 1; i >= 0; i--) raw = (raw << 8n) | BigInt(code.charCodeAt(i));
  return raw.toString();
}

/**
 * Whether a route credits this deposit on an unfinalized proof, and how far it
 * has got — the one answer the proof builder, the queue, a transfer's progress
 * and the health page all read, so they cannot disagree about it.
 *
 * `confirmations` is counted the way the contracts count it: blocks built on
 * top of the deposit's own, `head − block`. The light client's proved depth is
 * the length of the ancestry chain from the deposit's block up to, not
 * including, the signed header (`ethlightclnt`, `descend_to_carrier`:
 * `return ancestry.size()`), and the ledger takes the credit when
 * `depth >= route->min_confirmations` (the ledger's `credit`).
 *
 * Every refusal is one the ledger would make too, in the same order, so
 * declining here costs a sentence and accepting wrongly would cost a transaction.
 */
export type FastVerdict =
  | { offered: false; reason: string }
  | { offered: true; confirmations: number; required: number; left: number };

export function fastVerdict(route: RouteLimits | undefined, amount: bigint, confirmations: number): FastVerdict {
  if (!route) return { offered: false, reason: 'no route on the settlement chain for this token' };
  if (!route.depositsOpen) return { offered: false, reason: 'deposits are closed on this route' };
  if (route.optimisticMax === 0n) return { offered: false, reason: 'this route accepts finalized proofs only' };
  if (amount > route.optimisticMax) {
    return {
      offered: false,
      reason: `amount is above what this route credits on an unfinalized proof (${amount} > ${route.optimisticMax})`,
    };
  }
  const counted = Math.max(0, confirmations);
  return {
    offered: true,
    confirmations: counted,
    required: route.minConfirmations,
    left: Math.max(0, route.minConfirmations - counted),
  };
}

/** `5 of 12 confirmations; about 1 min more`, for a verdict still counting on a chain of `blockTime` seconds. */
export const confirmationsLeft = (v: Extract<FastVerdict, { offered: true }>, blockTime: number): string =>
  `${v.confirmations} of ${v.required} confirmations; about ${humanEta(v.left * blockTime)} more`;

export type FastProof = {
  confirmations: number;
  required: number;
  signedBy: string;
  blockNumber: number;
  proveroot: ReturnType<typeof proverootArgs>;
  credit: ReturnType<typeof creditArgs>;
};

/** Why a fast proof is not on offer, in a sentence a user can be shown. */
export class FastUnavailable extends Error {}

/**
 * Build the optimistic bundle for one log, to the route's current depth.
 *
 * Every reason it can decline is a rule the gateway would apply anyway, so
 * declining here costs a request and accepting wrongly would cost a
 * transaction.
 */
export async function buildFast(
  cfg: IndexerConfig,
  input: {
    txHash: string;
    blockNumber: number;
    topic0: string;
    amount: bigint;
    extToken: string;
    /** Which chain the deposit is on — a token address alone does not say. */
    domain: string;
  },
): Promise<FastProof> {
  const route = await routeFor(cfg, input.extToken, input.domain);
  // The head every endpoint has: a confirmation count read from the node that
  // is furthest ahead would promise a depth the node proving it cannot show.
  const head = await execHead();
  const verdict = fastVerdict(route, input.amount, head - input.blockNumber);
  if (!verdict.offered) throw new FastUnavailable(verdict.reason);
  if (verdict.left > 0) throw new FastUnavailable(confirmationsLeft(verdict, cfg.evm.blockTime));

  const block = await execRpc('eth_getBlockByNumber', [
    '0x' + input.blockNumber.toString(16),
    false,
  ]);
  const slot = slotForTimestamp(Number(block.timestamp));
  const beacon = new BeaconClient(cfg.beaconUrls[0]);

  // The committee signs a header `minConfirmations` blocks above the deposit,
  // and the chain of parents from there down to it is what the contract checks.
  // Signing the deposit's own block would prove only that it existed.
  const { headers: ancestry, tipSlot } = await ancestryOfLength(
    beacon,
    slot,
    verdict.required,
  );

  // The light client refuses an optimistic proof whose signed header is older
  // than its `clock` allows. By then the block is final, and the finalized
  // proof is the one to use.
  const maxAge = await signatureMaxAge(cfg);
  const tipAge = Math.floor(Date.now() / 1000) - (BEACON_GENESIS_TIME + tipSlot * SECONDS_PER_SLOT);
  if (tipAge > maxAge) {
    throw new FastUnavailable(
      `the deposit is past the fast window (${tipAge}s > ${maxAge}s); use the finalized proof`,
    );
  }
  const [update, carrierUpdate] = await Promise.all([
    updateFromBlocks(beacon, tipSlot),
    updateFromBlocks(beacon, slot),
  ]);

  const bundle = await buildOptimisticBundle({
    beaconUrl: cfg.beaconUrls[0],
    update,
    carrierUpdate,
    ancestry,
    target: input.txHash,
    // Pin the log, not the transaction: a deposit also carries the ERC-20
    // Transfer, and proving that one would be a proof of the wrong event.
    wantLog: { address: cfg.evm.vault!, topic0: input.topic0 },
  });

  return {
    confirmations: verdict.confirmations,
    required: verdict.required,
    signedBy: `${bundle.bls.signedCount}/${bundle.bls.committeeSize}`,
    blockNumber: bundle.event.blockNumber,
    proveroot: proverootArgs(bundle, cfg.accounts.lightClient),
    credit: creditArgs(bundle, cfg.accounts.gateway),
  };
}
