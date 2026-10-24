/**
 * The reads shared between requests: each one is slow, read by many pages, and
 * changes far slower than it is asked for, so one answer serves everyone for a
 * while. How long is written next to each.
 */

import { EVM_CHAINS } from '../../../src/chains/evm.ts';
import { antelopeById } from '../../../src/chains/antelope.ts';
import { BeaconClient } from '../../../src/evm/beacon.ts';
import { antelopeRpc, getTableRows } from '../../../src/net/antelope.ts';
import { committeeStatus } from '../../../src/status.ts';
import { activities, summary, type Activity, type ActivitySummary, type Period } from '../activity.ts';
import { chainsStatus } from '../chains.ts';
import { SETTLEMENT_CHAIN } from '../config.ts';
import { routesBetween } from '../hops.ts';
import { memo } from '../memo.ts';
import { ramReport, type RamRow } from '../ram.ts';
import { complete, reserves, type Reserve } from '../reserves.ts';
import { activityContext, rememberOutflows } from './context.ts';
import type { Deps } from './deps.ts';

/** RAM moves by a few hundred bytes a crossing; a minute between reads misses nothing. */
let ramMemo: (() => Promise<RamRow[]>) | undefined;

export function ramSoon(deps: Deps): Promise<RamRow[]> {
  ramMemo ??= memo(60_000, () => ramReport(deps.cfg));
  return ramMemo();
}

/**
 * Committee status is two network calls and both `/health` and `/v1/pending`
 * are polled, so the answer is held for a minute — far shorter than the 27
 * hours a rotation takes, so nothing is missed by not asking again.
 */
let committeeMemo: (() => ReturnType<typeof committeeStatus>) | undefined;

export function committeeSoon(deps: Deps): ReturnType<typeof committeeStatus> {
  committeeMemo ??= memo(60_000, () => committeeStatus(deps.cfg.savanna, new BeaconClient(deps.cfg.beaconUrls[0])));
  return committeeMemo();
}

/**
 * Every transfer, hops folded into one, shared for fifteen seconds: the feed is
 * public and every page view asks for it, while a crossing takes minutes.
 */
let activityMemo: (() => Promise<Activity[]>) | undefined;
export function activitySoon(deps: Deps): Promise<Activity[]> {
  activityMemo ??= memo(15_000, async () => activities(deps.store, activityContext(deps)));
  return activityMemo();
}

/** The summary of one period, over the shared feed, for half a minute. */
const summaryMemos = new Map<Period, () => Promise<ActivitySummary>>();
export function summarySoon(deps: Deps, period: Period) {
  let m = summaryMemos.get(period);
  if (!m) {
    m = memo(30_000, async () => summary(await activitySoon(deps), period, Math.floor(Date.now() / 1000), chainKind));
    summaryMemos.set(period, m);
  }
  return m();
}

/**
 * Issued on Telos against locked over there, for a minute — a few seconds when
 * something was not read: the vault balances come from `/v1/chains`, the
 * supplies are one table read per symbol.
 */
let reservesMemo: (() => Promise<{ asOf: number; assets: Reserve[] }>) | undefined;
export function reservesSoon(deps: Deps) {
  reservesMemo ??= memo(({ assets }) => (complete(assets) ? 60_000 : RETRY_PARTIAL_MS), async () => {
    const { sources } = await status(deps);
    const symbols = [...new Set((sources as any[]).flatMap((s) => (s.routes ?? []).map((r: any) => String(r.symbol))))];
    const supplies = new Map(await Promise.all(symbols.map(async (symbol) => {
      // Unread is `issued: null`, not a failed page: the vault side is still worth showing.
      const rows = await getTableRows<{ supply: string }>(deps.cfg.savanna, {
        code: deps.cfg.savanna.accounts.token,
        scope: symbol,
        table: 'stat',
      }).catch(() => []);
      return [symbol, rows[0]?.supply ?? null] as const;
    })));
    return { asOf: Math.floor(Date.now() / 1000), assets: reserves(sources as any[], (symbol) => supplies.get(symbol) ?? null) };
  });
  return reservesMemo();
}

/** The settlement chain and the Antelope registry's chains are Antelope; anything in the EVM registry is EVM. */
function chainKind(chain: string | null): 'antelope' | 'evm' | null {
  if (chain === null) return null;
  if (Object.values(EVM_CHAINS).some((c) => c.id === chain)) return 'evm';
  return chain === SETTLEMENT_CHAIN || antelopeById(chain) ? 'antelope' : null;
}

/**
 * `/v1/chains`, shared for fifteen seconds.
 *
 * Each computation reads every vault on its own chain — balances, limits, the
 * asset's flags, the pause bits, the head — and some of those chains are read
 * through a paid endpoint. Uncached, every visitor's page load was a dozen
 * billed calls; shared, the cost is fixed whatever the traffic. Nothing here
 * decides how fast a crossing goes: it is the page's view of the routes.
 */
let statusMemo: (() => Promise<Awaited<ReturnType<typeof chainsStatus>>>) | undefined;
export function status(deps: Deps) {
  statusMemo ??= memo(
    ({ sources }) => (allRead(sources as any[]) ? 15_000 : RETRY_PARTIAL_MS),
    async () => {
      const read = await chainsStatus(deps.cfg, { ...deps.savanna.state }, deps.keepers);
      rememberOutflows(read.sources as any[]);
      return read;
    },
  );
  return statusMemo();
}

/**
 * How long a read with a chain missing is kept. A DNS lookup that stalls for
 * five seconds fails every endpoint at once; the next read usually succeeds.
 */
const RETRY_PARTIAL_MS = 5_000;

/** Whether every chain and every vault in `/v1/chains` answered. */
const allRead = (sources: { error?: string; routes?: { outflowError?: string }[] }[]): boolean =>
  sources.every((s) => !s.error && (s.routes ?? []).every((r) => !r.outflowError));

/**
 * Every pair of chains an asset can cross between, read off `/v1/chains`.
 * As slow to compute as that, and as slow to change, so shared for half a
 * minute; whether the hop account runs code is asked with it.
 */
let routesMemo: (() => Promise<unknown[]>) | undefined;
export function routes(deps: Deps): Promise<unknown[]> {
  routesMemo ??= memo(30_000, async () => {
    const hop = deps.cfg.savanna.accounts.hop;
    const [status_, code] = await Promise.all([
      status(deps),
      hop ? antelopeRpc(deps.cfg.savanna, '/v1/chain/get_code_hash', { account_name: hop }).catch(() => undefined) : undefined,
    ]);
    const deployed = Boolean(code?.code_hash) && !/^0+$/.test(String(code.code_hash));
    return routesBetween(status_.sources as any[], { id: SETTLEMENT_CHAIN, name: deps.cfg.savanna.name }, { account: hop, deployed });
  });
  return routesMemo();
}
