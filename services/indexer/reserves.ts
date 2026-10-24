/**
 * What is bridged right now, per asset: what is issued on Telos, and what backs
 * it on the chains it came from.
 *
 * The sum of flows since launch says the same thing only while nothing is in
 * flight and nothing was ever lost to a bug. These are balances read from the
 * chains, so a page can put them side by side: locked over there, issued here.
 * The two differ by what is in flight — a withdrawal burned on Telos and not yet
 * released still sits in its vault — and by anything sent to a vault outside
 * the bridge.
 */

import { decimalAmount, decimalUnits } from '../../src/units.ts';

/** A chain as `/v1/chains` lists it, the fields read here. */
type Source = {
  id: string;
  /** `antelope` for an Antelope chain (WAX, XPR, Vaulta), whose vault is not read here; absent for an EVM chain. */
  kind?: 'antelope';
  /** Why the chain could not be read at all. */
  error?: string;
  routes?: {
    kind?: 'backing' | 'spoke';
    symbol: string;
    precision: number;
    /** Telos's record of what backs the route, or the room left under a spoke's cap. */
    available?: string | null;
    /** The vault's own balance, read on its chain; absent where none was read. */
    vaultHeld?: string;
    /** Why the vault was not read. */
    outflowError?: string;
    /** A spoke's mirrors outstanding over there. */
    locked?: string;
  }[];
};

/**
 * What backs an asset on one chain.
 *
 * `vault` is the vault's balance read on its chain. `ledger` is Telos's record
 * of it, and only for an Antelope chain, whose vault is not read here. `failed` is an EVM
 * vault that did not answer: its amount is unknown, which is not zero.
 */
export type Locked =
  | { chain: string; amount: string; read: 'vault' | 'ledger' }
  | { chain: string; amount: null; read: 'failed'; error: string };

export type Reserve = {
  symbol: string;
  precision: number;
  /** The wrapped token's supply on Telos; null when it could not be read. */
  issued: string | null;
  /** Every chain with a backing route for the asset, read or not. */
  locked: Locked[];
  /** The sum of `locked`; null while any of it failed, so a partial sum is never taken for the whole. */
  lockedTotal: string | null;
  /** How much of `issued` is out on another Antelope chain as a mirror. */
  mirrored: { chain: string; amount: string }[];
};

/** Whether every number was read: each supply on Telos and each vault behind it. */
export const complete = (assets: Reserve[]): boolean =>
  assets.every((a) => a.issued !== null && a.lockedTotal !== null);

/** Every asset any chain routes, from the chains' routes and Telos's `stat` supplies (`"0.39656382 ETH"`). */
export function reserves(sources: Source[], supply: (symbol: string) => string | null): Reserve[] {
  const out = new Map<string, Omit<Reserve, 'lockedTotal'> & { total: bigint }>();
  for (const s of sources) {
    for (const r of s.routes ?? []) {
      let a = out.get(r.symbol);
      if (!a) {
        const issued = supply(r.symbol);
        a = {
          symbol: r.symbol,
          precision: r.precision,
          // Through the units and back, so a supply in some other precision throws instead of misreading.
          issued: issued === null ? null : decimalAmount(decimalUnits(issued.split(' ')[0], r.precision), r.precision),
          locked: [],
          mirrored: [],
          total: 0n,
        };
        out.set(r.symbol, a);
      }
      if (r.kind === 'spoke') {
        if (r.locked !== undefined) a.mirrored.push({ chain: s.id, amount: decimalAmount(r.locked, r.precision) });
        continue;
      }
      const held = s.kind === 'antelope' ? r.available : r.vaultHeld;
      if (held === undefined || held === null) {
        a.locked.push({ chain: s.id, amount: null, read: 'failed', error: r.outflowError ?? s.error ?? 'the vault was not read' });
        continue;
      }
      a.locked.push({ chain: s.id, amount: decimalAmount(held, r.precision), read: s.kind === 'antelope' ? 'ledger' : 'vault' });
      a.total += BigInt(held);
    }
  }
  return [...out.values()]
    .sort((x, y) => x.symbol.localeCompare(y.symbol))
    .map(({ total, ...a }) => ({
      ...a,
      lockedTotal: a.locked.some((l) => l.read === 'failed') ? null : decimalAmount(total, a.precision),
    }));
}
