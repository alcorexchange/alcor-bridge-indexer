/**
 * `/health` and `/v1/stats`: whether this instance is following, and every
 * alarm an operator should see, worded for a public page.
 */

import { humanAmount } from '../../../src/units.ts';
import { minimumAlarms } from '../../../src/minimums.ts';
import { POLICY_LAG_ALARM } from '../../../src/status.ts';
import { SETTLEMENT_CHAIN } from '../config.ts';
import type { TransferRow } from '../db.ts';
import { assetFor, fastVerdict, routeFor, routeRoom, warmListings } from '../fast.ts';
import { holdOf, isLarge } from '../holds.ts';
import { lateFor } from '../progress.ts';
import { ramAlarms, type RamRow } from '../ram.ts';
import { upkeep } from '../upkeep.ts';
import { committeeSoon, ramSoon, status } from './cache.ts';
import { holdContext, progressContext } from './context.ts';
import { ancestryDeadline, type Deps } from './deps.ts';
import { exact, json, type Route } from './http.ts';

export const healthRoutes: Route[] = [
  {
    shown: '/health',
    match: (p) => (p === '/health' || p === '/' ? [] : null),
    handle: async ({ deps }) => json(200, await health(deps)),
  },
  { shown: '/v1/stats', operator: true, match: exact('/v1/stats'), handle: ({ deps }) => json(200, stats(deps)) },
];

/** A deposit held this long is an incident rather than a hiccup. */
const HELD_ALARM_SECONDS = 3600;
/** Ten minutes of half-second blocks: a history this far behind its chain's last irreversible block is an alarm. */
const HISTORY_BEHIND_BLOCKS = 1200;

/** How far back a large withdrawal stays on `/health`. */
const LARGE_WINDOW_SECONDS = 86_400;

/**
 * What `holds.ts` sees, for an operator: held deposits, deposits over a cap,
 * withdrawals waiting on a daily limit, and large withdrawals of the last day.
 * Then whatever is late with no hold to explain it (`lateFor`), whatever the
 * cause: a relayer down or out of RAM says nothing here by itself.
 * Worded like the rows themselves, since this page is public too.
 */
async function holdAlarms(deps: Deps): Promise<string[]> {
  await Promise.all([warmListings(deps.cfg), status(deps).catch(() => undefined)]);
  const ctx = holdContext(deps);
  const shown = (row: TransferRow) => {
    const asset = assetFor(row.token, row.domain);
    const amount = asset && row.amount !== null ? humanAmount(row.amount, asset.precision, asset.symbol) : `${row.amount} units`;
    // By its key, which a page and an alert can link to: `w:441`, `d:1:138`.
    return `${row.key} ${amount} ${row.direction === 'deposit' ? 'from' : 'to'} ${ctx.chainName(row.domain)}`;
  };
  const clock = (t: number) => new Date(t * 1000).toISOString().slice(11, 16) + ' UTC';

  const alarms: string[] = [];
  const list = (direction: 'deposit' | 'withdrawal', statuses: string[]) =>
    statuses.flatMap((status) => deps.store.listTransfers({ direction, status, limit: 500 }));

  const held = list('deposit', ['parked']).filter(
    (r) => holdOf(r, ctx)?.flag === 'held' && ctx.now - (r.dst_time ?? r.src_time) >= HELD_ALARM_SECONDS,
  );
  if (held.length) {
    alarms.push(`${held.length} deposit(s) held on Telos over an hour: ${held.slice(0, 5).map(shown).join(', ')}`);
  }

  for (const r of list('deposit', ['seen', 'provable'])) {
    if (holdOf(r, ctx)?.flag === 'over-limit') alarms.push(`deposit ${shown(r)} is over its route's cap and will not be credited`);
  }

  for (const r of list('withdrawal', ['burned', 'provable'])) {
    const hold = holdOf(r, ctx);
    if (hold?.flag !== 'daily-limit') continue;
    alarms.push(`withdrawal ${shown(r)} waits for the daily limit` + (hold.until ? ` until about ${clock(hold.until)}` : ''));
  }

  const since = ctx.now - LARGE_WINDOW_SECONDS;
  for (const r of list('withdrawal', ['burned', 'provable', 'released'])) {
    if (r.src_time < since) continue;
    const route = routeRoom(r.token, r.domain);
    if (!isLarge(r, route)) continue;
    const share = Number((BigInt(r.amount!) * 100n) / route!.maxWithdrawal);
    alarms.push(`large withdrawal ${shown(r)} at ${clock(r.src_time)}: ${share}% of the route's maximum`);
  }

  const progress = progressContext(deps);
  const late = [
    ...list('deposit', ['seen', 'provable', 'parked']),
    ...list('withdrawal', ['burned', 'provable']),
  ].flatMap((r) => {
    const waited = lateFor(r, progress);
    return waited === null ? [] : [{ r, waited }];
  });
  if (late.length) {
    const hours = (s: number) => `${(s / 3600).toFixed(1)}h`;
    alarms.push(
      `${late.length} crossing(s) waiting on the bridge far past their usual time: ` +
        late.slice(0, 5).map(({ r, waited }) => `${r.direction} ${shown(r)} (${hours(waited)})`).join(', '),
    );
  }
  return alarms;
}

async function health(deps: Deps) {
  const { cfg, savanna, store } = deps;
  const s = savanna.snapshot();
  const alarms: string[] = [];
  const now = Math.floor(Date.now() / 1000);

  const behind = s.head > 0 ? s.head - s.at : 0;
  const lagSeconds = (behind * cfg.savanna.blockIntervalMs) / 1000;
  if (lagSeconds > 300) alarms.push(`tree is ${behind} blocks behind (${Math.round(lagSeconds)}s)`);
  if (s.mismatches > 0) alarms.push(`${s.mismatches} root(s) the chain disagreed with`);

  const unfrozen = store.unfrozenWithdrawals();
  if (unfrozen.length) alarms.push(`${unfrozen.length} burned withdrawal(s) with no stored proof`);

  // A follower that cannot advance, which is not the same as one that is behind.
  //
  // This is the alarm that was missing. BSC testnet sat on one 2000-block range
  // for 44 hours because its logs had been pruned out from under the saved
  // position, retrying it every poll and losing ground the whole time — and the
  // only trace was a `lastError` string nobody watches. Ten minutes is far longer
  // than any honest scan step and far shorter than a retention window, so an
  // alarm here is still actionable: move the position forward while the gap is
  // small enough that some endpoint still serves it.
  const stallSeconds = 600;
  for (const f of deps.evms) {
    const stuckFor = now - f.state.atMovedAt;
    if (f.state.at >= f.state.head || stuckFor < stallSeconds) continue;
    alarms.push(
      `${f.id} has not advanced in ${Math.round(stuckFor / 60)} min at block ${f.state.at}, ` +
        `${f.state.head - f.state.at} behind the head` +
        (f.state.lastError ? ` — ${f.state.lastError}` : ''),
    );
  }

  // Our own history of a chain, stopped or behind: swaps there show nothing new,
  // and a gap past the node's retention is filled by hand. Irreversible blocks
  // only, so a few minutes behind the head is normal on WAX and XPR.
  for (const h of deps.histories) {
    const stuckFor = now - h.state.atMovedAt;
    if (stuckFor < stallSeconds && h.state.lib - h.state.at < HISTORY_BEHIND_BLOCKS) continue;
    alarms.push(
      `history of ${h.chain} is at block ${h.state.at}, ${h.state.lib - h.state.at} behind its last irreversible, ` +
        `not advanced in ${Math.round(stuckFor / 60)} min` + (h.state.lastError ? ` — ${h.state.lastError}` : ''),
    );
  }

  // The tightest deadline in the system, and the one nothing else reports: a
  // beacon deposit's finalized proof stops fitting in one transaction
  // (`ancestryDeadline`). A deposit still unfrozen at three quarters of that is
  // an incident, because the thing that would freeze it is this process. Every
  // other chain has no such clock, and alarming on it was a false alarm.
  for (const d of store.listTransfers({ direction: 'deposit', status: 'seen', limit: 100 })) {
    const deadline = ancestryDeadline(cfg, d);
    if (deadline === undefined || now - d.src_time < (deadline - d.src_time) * 0.75) continue;

    // Only where the finalized proof is the ONLY proof. The fast path's ancestry
    // is `min_confirmations` headers whatever the block's age, so on a route that
    // accepts unfinalized proofs nothing has expired — and an alarm saying
    // otherwise, beside a queue offering the deposit as ready, is a page that
    // argues with itself.
    const route = d.token ? await routeFor(cfg, d.token, String(d.domain)).catch(() => undefined) : undefined;
    if (fastVerdict(route, BigInt(d.amount ?? 0), 0).offered) continue;

    const age = now - d.src_time;
    const left = Math.max(0, deadline - now);
    alarms.push(
      left > 0
        ? `deposit #${d.ref} has been unproved for ${(age / 3600).toFixed(1)}h — ` +
          `${(left / 3600).toFixed(1)}h before its proof no longer fits in one transaction`
        : `deposit #${d.ref} is ${(age / 3600).toFixed(1)}h old and its route takes finalized ` +
          `proofs only, so it can no longer be proved in one transaction`,
    );
  }

  // The one rotation that cannot skip: a committee is only provable by the one
  // before it, so two periods behind is an incident and not a metric.
  let committee: unknown = null;
  try {
    const c = await committeeSoon(deps);
    committee = c;
    if (c.lagPeriods > 1) {
      alarms.push(`sync committee is ${c.lagPeriods} periods behind — deposits will start failing`);
    }
  } catch (err) {
    committee = { error: (err as Error).message };
  }

  // A light client whose held seats no longer carry a quorum: the finalizers
  // who left took their weight with them, and withdrawals need the policy
  // advanced first. Without a reading of the quorum, the generation count.
  try {
    for (const c of (await upkeep(cfg, store)).chains) {
      if (!c.policy) continue;
      const q = c.policy.quorum;
      if (q ? q.spare <= 0 : c.policy.lag >= POLICY_LAG_ALARM) {
        alarms.push(
          `${c.chain} light client holds generation ${c.policy.held}, Telos is on ${c.policy.active}` +
            (q ? `: ${q.present} of its seats' weight still finalizes, the threshold is ${q.threshold}` : ''),
        );
      }
      if (c.policy.blocked) alarms.push(`${c.chain}: ${c.policy.blocked}`);
    }
  } catch (err) {
    alarms.push(`upkeep: ${(err as Error).message}`);
  }

  // Crossings something stopped, and withdrawals large enough to look at.
  try {
    alarms.push(...(await holdAlarms(deps)));
  } catch (err) {
    alarms.push(`holds: ${(err as Error).message}`);
  }

  // Floors out of the order a deposit address relies on (minimums.ts).
  try {
    alarms.push(...minimumAlarms((await status(deps)).sources as any[]));
  } catch (err) {
    alarms.push(`minimums: ${(err as Error).message}`);
  }

  // RAM the bridge's own rows are paid from. Out of it, every route stops.
  let ram: RamRow[] | { error: string };
  try {
    ram = await ramSoon(deps);
    alarms.push(...ramAlarms(ram));
  } catch (err) {
    ram = { error: (err as Error).message };
    alarms.push(`ram: ${(err as Error).message}`);
  }

  return {
    instance: cfg.instance,
    status: alarms.length ? 'degraded' : s.caughtUp ? 'following' : 'catching-up',
    // The discoverable entry point. The route list at the bare root is not
    // reachable through the proxy, which only forwards the prefix.
    docs: `${cfg.basePath}/docs`,
    uptimeSeconds: Math.floor((Date.now() - deps.startedAt) / 1000),
    alarms,
    savanna: {
      chain: SETTLEMENT_CHAIN,
      at: s.at,
      head: s.head,
      behind,
      behindSeconds: Math.round(lagSeconds),
      caughtUp: s.caughtUp,
      leaves: s.leaves,
      frozen: s.frozen,
      mismatches: s.mismatches,
      window: { from: s.windowFrom, blocks: s.windowBlocks, target: s.windowTarget, bytes: s.bytes },
      lastError: s.lastError,
    },
    // One entry per source chain, this instance's own first.
    sources: deps.evms.map((f) => ({
      chain: f.id,
      at: f.state.at,
      head: f.state.head,
      behind: f.state.head - f.state.at,
      caughtUp: f.state.caughtUp,
      seenThisRun: { deposits: f.state.deposits, frozen: f.state.frozen, headRaces: f.state.headRaces },
      wiring: f.state.wiring.length ? f.state.wiring : 'as configured',
      lastError: f.state.lastError,
    })),
    histories: deps.histories.map((h) => ({
      chain: h.chain,
      at: h.state.at,
      lib: h.state.lib,
      behind: h.state.lib - h.state.at,
      lastError: h.state.lastError,
    })),
    // From storage, not from this run's counters. A restart resumes from the
    // saved scan position and sees nothing again, and a health page that then
    // reports "0 trusted roots" is worse than one that reports nothing.
    trustedRoots: store.rootCount(),
    committee,
    ram,
    transfers: deps.store.countsByStatus(),
    storage: {
      proofs: deps.store.proofStats(),
      committees: deps.store.committeeStats(),
      leafBytes: s.bytes,
    },
    incidents: deps.store.recentIncidents(10),
  };
}

function stats(deps: Deps) {
  return {
    instance: deps.cfg.instance,
    byStatus: deps.store.countsByStatus(),
    proofs: deps.store.proofStats(),
    committees: deps.store.committeeStats(),
    trustedRoots: deps.store.rootCount(),
  };
}
