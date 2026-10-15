/**
 * The bridge's activity as the people using it see it: one entry per transfer.
 *
 * The ledger keeps legs. A hop from Ethereum to WAX is a deposit to the hop
 * contract and the withdrawal it opens; a deposit refused on Telos is the
 * deposit and the withdrawal that sends it back. Two rows each, one transfer
 * each — counted as rows, both the number of transfers and the volume come out
 * doubled. Here every leg is folded into the transfer it belongs to:
 *
 *   hop      a journey through the hop contract, keyed by its deposit, as
 *            `/v1/hops/<key>` serves it
 *   direct   one crossing to or from Telos, keyed by its row, as
 *            `/v1/transfers/<key>` serves it
 *
 * and a leg never appears as a transfer of its own, in the feed or in a sum.
 */

import { SETTLEMENT_CHAIN } from './config.ts';
import type { Store, TransferRow, TransferStatus } from './db.ts';
import { journey } from './hops.ts';
import { transferProgress, type Progress, type ProgressContext } from './progress.ts';
import { decimalAmount, decimalUnits } from './units.ts';

export const STATES = ['in_progress', 'action_needed', 'delivered', 'returned'] as const;
export type ActivityState = (typeof STATES)[number];

export type Activity = {
  /** The deposit's key for a hop, the row's key for a direct transfer. */
  key: string;
  kind: 'direct' | 'hop';
  /** Who sent it: an EVM address or an Antelope account. */
  from: { chain: string | null; address: string | null };
  /** Who gets it on the chain it ends on. Null where a refused hop's memo did not say. */
  to: { chain: string | null; recipient: string | null };
  /** Null for a token this build has no listing for. */
  asset: { symbol: string; precision: number } | null;
  /** A decimal string in `asset.precision`, never a float. */
  amount: string | null;
  state: ActivityState;
  waitingOn: Progress['waitingOn'];
  stage: string;
  /** When it was sent, on the chain it was sent from. */
  startedAt: number;
  /** When it landed where it ended: delivered, or back with the sender. Null until then, or where unrecorded. */
  finishedAt: number | null;
  srcTx: string | null;
  /** The transaction that paid it out where it ended. */
  dstTx: string | null;
};

export type ActivityContext = {
  /** The hop contract; deposits to it are journeys. */
  hop: string | undefined;
  chainOf: (domain: string | null) => string | null;
  asset: (token: string | null, domain: string | null) => { symbol: string; precision: number } | undefined;
  progress: ProgressContext;
};

const DELIVERED: TransferStatus[] = ['credited', 'forwarded', 'released'];
const RETURNED: TransferStatus[] = ['bounced', 'expired', 'refunded'];

/** Not finished: whose move it is decides between the two open states. */
const open = (p: Progress): ActivityState => (p.waitingOn === 'user' ? 'action_needed' : 'in_progress');

/** Newest first; the key breaks a tie, so a cursor always lands in one place. */
export function newestFirst(a: Activity, b: Activity): number {
  return b.startedAt - a.startedAt || (a.key < b.key ? 1 : a.key > b.key ? -1 : 0);
}

/** Every transfer the store knows, newest first. */
export function activities(store: Store, ctx: ActivityContext): Activity[] {
  const rows = store.allTransfers();

  // A refused deposit is sent back by a withdrawal opened in the transaction
  // that refuses it, and that transaction is the deposit's `dst_tx`.
  const bySrcTx = new Map<string, TransferRow>();
  for (const r of rows) if (r.direction === 'withdrawal' && r.src_tx) bySrcTx.set(r.src_tx, r);
  const backOf = (d: TransferRow) => (d.status === 'bounced' && d.dst_tx ? bySrcTx.get(d.dst_tx) : undefined);

  const legs = new Set<string>();
  for (const r of rows) {
    if (r.direction === 'deposit') {
      const back = backOf(r);
      if (back) legs.add(back.key);
    } else if (store.getHop(r.ref) || (ctx.hop !== undefined && r.account === ctx.hop)) {
      legs.add(r.key);
    }
  }

  return rows
    .filter((r) => !legs.has(r.key))
    .map((r) =>
      r.direction === 'deposit' && ctx.hop !== undefined && r.account === ctx.hop
        ? hopActivity(store, r, ctx, backOf)
        : directActivity(r, ctx, backOf),
    )
    .sort(newestFirst);
}

/** Where a row ended, if it has: the payout, or the way back to the sender. */
function ending(row: TransferRow, backOf: (d: TransferRow) => TransferRow | undefined) {
  if (DELIVERED.includes(row.status)) return { at: row.dst_time, tx: row.dst_tx };
  if (row.status === 'refunded') return { at: null, tx: row.refund_tx };
  const back = backOf(row);
  if (back?.status === 'released') return { at: back.dst_time, tx: back.dst_tx };
  return { at: null, tx: null };
}

function priced(row: TransferRow, ctx: ActivityContext) {
  const asset = ctx.asset(row.token, row.domain) ?? null;
  return {
    asset: asset && { symbol: asset.symbol, precision: asset.precision },
    amount: asset && row.amount !== null ? decimalAmount(row.amount, asset.precision) : null,
  };
}

function directActivity(row: TransferRow, ctx: ActivityContext, backOf: (d: TransferRow) => TransferRow | undefined): Activity {
  const progress = transferProgress(row, ctx.progress);
  const far = ctx.chainOf(row.domain);
  const deposit = row.direction === 'deposit';
  const end = ending(row, backOf);
  return {
    key: row.key,
    kind: 'direct',
    from: deposit ? { chain: far, address: row.evm_address } : { chain: SETTLEMENT_CHAIN, address: row.account },
    to: deposit ? { chain: SETTLEMENT_CHAIN, recipient: row.account } : { chain: far, recipient: row.evm_address },
    ...priced(row, ctx),
    state: DELIVERED.includes(row.status) ? 'delivered' : RETURNED.includes(row.status) ? 'returned' : open(progress),
    waitingOn: progress.waitingOn,
    stage: progress.stage,
    startedAt: row.src_time,
    finishedAt: end.at,
    srcTx: row.src_tx,
    dstTx: end.tx,
  };
}

function hopActivity(store: Store, row: TransferRow, ctx: ActivityContext, backOf: (d: TransferRow) => TransferRow | undefined): Activity {
  const j = journey(store, row.key, (r) => r, ctx.chainOf, ctx.hop, ctx.progress)!;
  const last = j.legs.at(-1)?.transfer;
  const state: ActivityState =
    j.status === 'delivered' ? 'delivered'
      : j.status === 'returned' || j.status === 'bounced' ? 'returned'
        : open(j.progress);
  // Refused on Telos, it ends where a direct deposit would; otherwise where its last leg was paid out.
  let end: { at: number | null; tx: string | null } = { at: null, tx: null };
  if (j.status === 'bounced') end = ending(row, backOf);
  else if ((j.status === 'delivered' || j.status === 'returned') && last) end = { at: last.dst_time, tx: last.dst_tx };
  return {
    key: row.key,
    kind: 'hop',
    from: { chain: ctx.chainOf(row.domain), address: row.evm_address },
    to: { chain: j.to?.chain ?? null, recipient: j.to?.recipient ?? null },
    ...priced(row, ctx),
    state,
    waitingOn: j.progress.waitingOn,
    stage: j.progress.stage,
    startedAt: row.src_time,
    finishedAt: end.at,
    srcTx: row.src_tx,
    dstTx: end.tx,
  };
}

// --- the feed ---------------------------------------------------------------------

export type ActivityFilter = {
  chain?: string;
  asset?: string;
  state?: ActivityState;
  /** The start of an EVM address or an Antelope account, at either end. */
  party?: string;
};

const encodeCursor = (a: Activity) => Buffer.from(`${a.startedAt}|${a.key}`).toString('base64url');

function decodeCursor(cursor: string): Pick<Activity, 'startedAt' | 'key'> {
  const text = Buffer.from(cursor, 'base64url').toString();
  const bar = text.indexOf('|');
  const startedAt = Number(text.slice(0, bar));
  if (bar < 1 || !Number.isSafeInteger(startedAt)) throw new Error('cursor is not one this API handed out');
  return { startedAt, key: text.slice(bar + 1) };
}

const startsWith = (name: string | null | undefined, prefix: string) => !!name?.toLowerCase().startsWith(prefix);

export function feed(all: Activity[], filter: ActivityFilter, limit: number, cursor?: string) {
  const party = filter.party?.trim().toLowerCase();
  const symbol = filter.asset?.toUpperCase();
  const matching = all.filter((a) =>
    (!filter.chain || a.from.chain === filter.chain || a.to.chain === filter.chain) &&
    (!symbol || a.asset?.symbol === symbol) &&
    (!filter.state || a.state === filter.state) &&
    (!party || startsWith(a.from.address, party) || startsWith(a.to.recipient, party)),
  );
  const after = cursor ? decodeCursor(cursor) : undefined;
  const start = after ? matching.findIndex((a) => newestFirst(after as Activity, a) < 0) : 0;
  const items = start < 0 ? [] : matching.slice(start, start + limit);
  const more = start >= 0 && start + limit < matching.length;
  return { items, cursor: more ? encodeCursor(items.at(-1)!) : null };
}

// --- the summary ------------------------------------------------------------------

export const DAY = 24 * 3600;

/** The windows a page asks about, by name, in seconds; `all` has no start. */
export const PERIODS = { '24h': DAY, '7d': 7 * DAY, '30d': 30 * DAY, all: null } as const;
export type Period = keyof typeof PERIODS;

type Duration = { median: number; p90: number } | null;
type Amounts = { symbol: string; amount: string }[];

/** Which kind of chain a registry id names; null for one this build does not know. */
export type ChainKind = (chain: string | null) => 'antelope' | 'evm' | null;

/** Nearest-rank percentiles of how long delivered transfers took; null with none. */
function duration(items: Activity[]): Duration {
  const took = items
    .filter((a) => a.state === 'delivered' && a.finishedAt !== null)
    .map((a) => a.finishedAt! - a.startedAt)
    .sort((x, y) => x - y);
  if (!took.length) return null;
  const rank = (p: number) => took[Math.max(0, Math.ceil(p * took.length) - 1)];
  return { median: rank(0.5), p90: rank(0.9) };
}

/** Sums by asset, keyed by symbol and precision so two precisions of one symbol never add up. */
class Totals {
  private sums = new Map<string, { symbol: string; precision: number; units: bigint }>();

  add(a: Activity): void {
    const units = unitsOf(a);
    if (units === null) return;
    const k = `${a.asset!.symbol}|${a.asset!.precision}`;
    const s = this.sums.get(k) ?? { symbol: a.asset!.symbol, precision: a.asset!.precision, units: 0n };
    s.units += units;
    this.sums.set(k, s);
  }

  list(): Amounts {
    return [...this.sums.values()]
      .sort((x, y) => x.symbol.localeCompare(y.symbol))
      .map((s) => ({ symbol: s.symbol, amount: decimalAmount(s.units, s.precision) }));
  }
}

/**
 * What a transfer moved, in canonical units. A returned one moved nothing:
 * the money is back where it started, so it counts as a transfer and adds no
 * volume.
 */
function unitsOf(a: Activity): bigint | null {
  if (a.state === 'returned' || a.asset === null || a.amount === null) return null;
  return decimalUnits(a.amount, a.asset.precision);
}

const dayOf = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);

export function summary(all: Activity[], period: Period, now: number, kind: ChainKind) {
  const span = PERIODS[period];
  const since = span === null ? null : now - span;
  const items = since === null ? all : all.filter((a) => a.startedAt >= since);

  const byState = Object.fromEntries(STATES.map((s) => [s, 0])) as Record<ActivityState, number>;
  for (const a of items) byState[a.state]++;

  // In and out of Antelope, per asset. A transfer between two Antelope chains,
  // or between two EVM chains, is neither: it is counted, and moves no total.
  const assets = new Map<string, { symbol: string; precision: number; transfers: number; to: bigint; from: bigint }>();
  for (const a of items) {
    if (!a.asset) continue;
    const k = `${a.asset.symbol}|${a.asset.precision}`;
    const s = assets.get(k) ?? { ...a.asset, transfers: 0, to: 0n, from: 0n };
    s.transfers++;
    const units = unitsOf(a) ?? 0n;
    const [src, dst] = [kind(a.from.chain), kind(a.to.chain)];
    if (src === 'evm' && dst === 'antelope') s.to += units;
    if (src === 'antelope' && dst === 'evm') s.from += units;
    assets.set(k, s);
  }

  const routes = new Map<string, { from: string; to: string; items: Activity[]; totals: Totals }>();
  for (const a of items) {
    const from = a.from.chain ?? 'unknown';
    const to = a.to.chain ?? 'unknown';
    const r = routes.get(`${from}>${to}`) ?? { from, to, items: [], totals: new Totals() };
    r.items.push(a);
    r.totals.add(a);
    routes.set(`${from}>${to}`, r);
  }

  // Every UTC day of the window, those with nothing on them too: a chart's axis.
  const days = new Map<string, { transfers: number; totals: Totals }>();
  const first = since ?? Math.min(now, items.at(-1)?.startedAt ?? now); // newest first: the last is the oldest
  for (let t = Date.parse(`${dayOf(first)}T00:00:00Z`) / 1000; t <= now; t += DAY) {
    days.set(dayOf(t), { transfers: 0, totals: new Totals() });
  }
  for (const a of items) {
    const d = days.get(dayOf(a.startedAt));
    if (!d) continue; // started after `now`: a clock a second ahead of ours
    d.transfers++;
    d.totals.add(a);
  }

  return {
    period,
    since,
    transfers: items.length,
    wallets: new Set(items.map((a) => a.from.address?.toLowerCase()).filter((x) => x)).size,
    byState,
    duration: duration(items),
    assets: [...assets.values()]
      .sort((x, y) => x.symbol.localeCompare(y.symbol))
      .map((s) => ({
        symbol: s.symbol,
        precision: s.precision,
        transfers: s.transfers,
        toAntelope: decimalAmount(s.to, s.precision),
        fromAntelope: decimalAmount(s.from, s.precision),
        net: decimalAmount(s.to - s.from, s.precision),
      })),
    routes: [...routes.values()]
      .sort((x, y) => y.items.length - x.items.length || `${x.from}>${x.to}`.localeCompare(`${y.from}>${y.to}`))
      .map((r) => ({
        from: r.from,
        to: r.to,
        transfers: r.items.length,
        duration: duration(r.items),
        amounts: r.totals.list(),
      })),
    daily: [...days.entries()].map(([day, d]) => ({ day, transfers: d.transfers, amounts: d.totals.list() })),
  };
}

export type ActivitySummary = ReturnType<typeof summary>;
