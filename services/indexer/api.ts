/**
 * The HTTP surface, which is the whole point of the service.
 *
 * The rule it is written to: a front end should never have to know how a proof
 * is made, which of the two settlement tracks is cheaper today, or what any of
 * the chains' retention windows are. It asks for a transfer and gets a status a
 * human would recognise; it asks for a proof and gets arguments ready to push.
 * Everything difficult stays here.
 *
 * Nothing is served that was not verified when it was stored: a release proof
 * had every fold checked before it was written, and a re-branch is checked again
 * on the way out. An endpoint that returned a proof the chain would reject would
 * be worse than one that returned nothing.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EVM_CHAINS } from '../../src/chains/evm.ts';
import { antelopeDepositEta, antelopeWithdrawalEta, depositEta, humanEta, nearDepositEta, nearWithdrawalEta, suiDepositEta, suiWithdrawalEta, withdrawalEta } from '../../src/chains/eta.ts';
import { isTrusted, knowsKey, nearVaultState } from '../../src/near/client.ts';
import { nearRpc } from '../../src/near/rpc.ts';
import { handoverCalls, settleCalls as nearSettleCalls } from '../../src/near/withdrawal.ts';
import { fetchRegistrations, type Registration } from '../../src/savanna/registrations.ts';
import { TELOS_HISTORY } from '../../src/config.ts';
import { nearAccountKey, nearRouteOf } from './nearVault.ts';
import { clientState, vaultState, type VaultState } from '../../src/sui/client.ts';
import { installPolicyCall, settleCall, submitRootCall } from '../../src/sui/withdrawal.ts';
import { antelopeById } from '../../src/chains/antelope.ts';
import { SLOT_SECONDS } from '../../src/config.ts';
import { proverootPositional } from '../../src/proofs.ts';
import { antelopeToken, chainsStatus } from './chains.ts';
import { humanAmount, parseAsset } from './units.ts';
import { minimumAlarms } from './minimums.ts';
import { epochBacklog } from './parlia.ts';
import { proverootArgs as polygonProveroot } from '../../src/polygon/proof.ts';
import { SETTLEMENT_CHAIN, chainOfDomain, type Domain, type IndexerConfig } from './config.ts';
import { BOOKED, SETTLED, Store, voidKey, withdrawalKey, type HopRow, type TransferRow } from './db.ts';
import { TOPICS } from './evm.ts';
import type { SettlementFollower } from './savanna.ts';
import type { EvmFollower } from './evm.ts';
import type { BlockrootKeeper } from './blockroot.ts';
import { rebranch, treeThrough } from './tree.ts';
import { assetFor, buildFast, confirmationsLeft, fastVerdict, routeFor, routeLimits, routeRoom, warmListings, FastUnavailable } from './fast.ts';
import { holdOf, isLarge, type HoldContext, type Outflow } from './holds.ts';
import { lateFor, transferProgress, type Progress, type ProgressContext } from './progress.ts';
import { finalizerKeys } from './finalizerKeys.ts';
import { memo } from './memo.ts';
import { ramAlarms, ramReport, type RamRow } from './ram.ts';
import { upkeep } from './upkeep.ts';
import { volume } from './volume.ts';
import { hopLink, journey, journeyOf as journeyKeyOf, routesBetween, type HopLink } from './hops.ts';
import { complete, reserves, type Reserve } from './reserves.ts';
import { activities, feed, PERIODS, STATES, summary, type Activity, type ActivityState, type ActivitySummary, type Period } from './activity.ts';

import { committeeStatus, POLICY_LAG_ALARM } from '../../src/status.ts';
import { antelopeRpc, getTableRows } from '../../src/net/antelope.ts';
import { BeaconClient } from '../../src/evm/beacon.ts';
import type { WithdrawalArtifact } from '../../src/savanna/withdrawalArtifact.ts';
import { frozenSubmitRoot } from '../../src/savanna/withdrawalProof.ts';
import { swapOfPayout, type SwapView } from './swaps.ts';
import { evmSwapQuote, QuoteRefused } from './quote.ts';
import { alcorQuote, PlanRefused, swapPlan, type ChainReader, type PlanChain, type PlanRoute } from './plan.ts';

/** How long a proved deposit may sit uncredited before a UI should say so. */
const DEPOSIT_STUCK_SECONDS = 30 * 60;

/** A domain this instance follows as an EVM source. */
type EvmDomain = Extract<Domain, { kind: 'evm' }>;

/** A request the API refuses as asked, answered 400 with the message. */
class BadRequest extends Error {}

/** A whole-number query parameter between `min` and `max`; undefined when absent. */
function intParam(q: URLSearchParams, name: string, min: number, max: number): number | undefined {
  const raw = q.get(name);
  if (raw === null || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new BadRequest(`${name} is a whole number from ${min} to ${max}`);
  return n;
}

/**
 * The documents, served from the API they describe.
 *
 * The repository is private, so a GitHub link is a link most of the people who
 * need these cannot open. Serving them here makes them public to exactly whoever
 * can already call the API, and makes it impossible for a document to describe a
 * version other than the one answering — they ship together.
 *
 *   /docs       the front-end walkthrough and every endpoint
 *   /docs/bot   the same bridge from a bot's side: what to sign on each chain
 */
const DOCS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../docs');
const DOCS: Record<string, string> = {
  '/docs': 'API.md',
  '/docs/bot': 'BOT-INTEGRATION.md',
};
const docsCache = new Map<string, string>();

function docs(path: string): string {
  let text = docsCache.get(path);
  if (text === undefined) {
    try {
      text = readFileSync(join(DOCS_DIR, DOCS[path]), 'utf8');
    } catch {
      text = '';
    }
    docsCache.set(path, text);
  }
  return text;
}

export type Deps = {
  cfg: IndexerConfig;
  store: Store;
  savanna: SettlementFollower;
  /**
   * Every source chain's follower, this instance's own chain first.
   *
   * There used to be a second field holding just that first one, for everything
   * written while one process followed one chain. It outlived its use and became
   * a trap: `fastReady` reached for it and measured an Amoy deposit's depth
   * against the Sepolia head. A row names its domain — look the follower up.
   */
  evms: EvmFollower[];
  /** A blockroot keeper per legacy chain this instance follows, by chain id. */
  keepers: Map<string, BlockrootKeeper>;
  startedAt: number;
};

export function createApi(deps: Deps) {
  const server = createServer((req, res) => {
    handle(deps, req, res).catch((err) => {
      send(res, err instanceof BadRequest ? 400 : 500, { error: (err as Error).message });
    });
  });
  return server;
}

async function handle(deps: Deps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const raw = url.pathname.replace(/\/+$/, '') || '/';
  const q = url.searchParams;
  const base = deps.cfg.basePath;

  // A UI is served from somewhere else; this is public, read-only data.
  res.setHeader('access-control-allow-origin', '*');

  // One table read per request, shared by every row rendered from it. A listing
  // added a minute ago shows up here without a restart; that is all "picking up
  // a new token" amounts to.
  await warmListings(deps.cfg).catch(() => undefined);
  // The vaults' daily limits, for a withdrawal waiting on one (`holds.ts`).
  // Not awaited: a row renders with the last reading, shared for fifteen seconds.
  status(deps).catch(() => undefined);

  // The prefix is served here rather than stripped by a proxy, so the path in a
  // log is the path in a browser. The bare root stays a liveness answer, because
  // something always ends up curling it.
  if (base && raw === '/') {
    return send(res, 200, {
      instance: deps.cfg.instance,
      api: `${base}/health`,
      docs: `${base}/docs`,
      botDocs: `${base}/docs/bot`,
      routes: [
        `${base}/health`,
        `${base}/v1/stats`,
        `${base}/v1/volume`,
        `${base}/v1/chains`,
        `${base}/v1/routes`,
        `${base}/v1/pending`,
        `${base}/v1/transfers`,
        `${base}/v1/transfers/<key>`,
        `${base}/v1/proofs/<key>`,
        `${base}/v1/handovers?after=<generation>[&limit=50]`,
        `${base}/v1/hops`,
        `${base}/v1/swap/quote?chain=&tokenIn=&tokenOut=&amountIn=[&slippageBps=50]`,
        `${base}/v1/swap/plan?from=&to=&amount=&recipient=&sender=[&slippageBps=50][&deadlineSeconds=1800]`,
        `${base}/v1/hops/<key>`,
        `${base}/v1/accounts/<account>`,
        `${base}/v1/accounts/<account>/transfers`,
        `${base}/v1/activity`,
        `${base}/v1/activity/summary`,
        `${base}/v1/reserves`,
        `${base}/v1/finalizer-keys`,
        `${base}/v1/upkeep`,
        `${base}/v1/savanna/branch/<block>`,
        ...[...deps.keepers.keys()].flatMap((id) => [`${base}/v1/${id}`, `${base}/v1/${id}/blockroot/<block>`]),
      ],
    });
  }
  if (base && !(raw === base || raw.startsWith(`${base}/`))) {
    return send(res, 404, { error: `no route for ${raw}; this instance serves under ${base}` });
  }
  const path = base ? raw.slice(base.length) || '/' : raw;

  if (path === '/health' || path === '/') return send(res, 200, await health(deps));

  if (Object.hasOwn(DOCS, path)) {
    const text = docs(path);
    if (!text) return send(res, 404, { error: 'this build carries no documentation' });
    res.writeHead(200, {
      'content-type': 'text/markdown; charset=utf-8',
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
    });
    return void res.end(text);
  }
  if (path === '/v1/stats') return send(res, 200, stats(deps));
  if (path === '/v1/volume') {
    const days = intParam(q, 'days', 1, 366) ?? 30;
    return send(res, 200, volume(deps.store, (domain, token) => {
      const listed = assetFor(token, domain);
      return { chain: chainOf(deps, domain), symbol: listed?.symbol ?? null, precision: listed?.precision ?? null };
    }, Math.floor(Date.now() / 1000), days));
  }
  if (path === '/v1/chains') {
    return send(res, 200, await status(deps));
  }
  if (path === '/v1/handovers') {
    return send(res, 200, await handovers(deps, intParam(q, 'after', 0, 2 ** 32) ?? 0, intParam(q, 'limit', 1, 100) ?? 50), 30);
  }
  if (path === '/v1/routes') {
    const all = (await routes(deps)) as { symbol: string; from: string; to: string }[];
    const symbol = q.get('symbol');
    const from = q.get('from');
    const to = q.get('to');
    const picked = all.filter((r) => (!symbol || r.symbol === symbol) && (!from || r.from === from) && (!to || r.to === to));
    return send(res, 200, { routes: picked, count: picked.length });
  }
  if (path === '/v1/swap/quote') {
    const chain = q.get('chain') ?? '';
    const source = (await status(deps)).sources.find((x) => x.id === chain) as { routes: { token: string | null }[] } | undefined;
    try {
      const quote = await evmSwapQuote({
        chain,
        tokenIn: q.get('tokenIn') ?? '',
        tokenOut: q.get('tokenOut') ?? '',
        amountIn: q.get('amountIn') ?? '',
        slippageBps: Number(q.get('slippageBps') ?? 50),
      }, (source?.routes ?? []).flatMap((r) => (r.token ? [r.token] : [])));
      return send(res, 200, quote);
    } catch (err) {
      return send(res, err instanceof QuoteRefused ? 400 : 502, { error: (err as Error).message });
    }
  }
  if (path === '/v1/swap/plan') {
    try {
      const [all, current] = await Promise.all([routes(deps), status(deps)]);
      const plan = await swapPlan({
        from: q.get('from') ?? '',
        to: q.get('to') ?? '',
        amount: q.get('amount') ?? '',
        recipient: q.get('recipient') ?? '',
        sender: q.get('sender') ?? '',
        slippageBps: Number(q.get('slippageBps') ?? 50),
        deadlineSeconds: Number(q.get('deadlineSeconds') ?? 1800),
      }, {
        routes: all as PlanRoute[],
        chains: current.sources as PlanChain[],
        settlement: { bridge: deps.cfg.savanna.accounts.bridge, hop: deps.cfg.savanna.accounts.hop ?? null },
        quote: alcorQuote,
        read: chainReader(deps.cfg),
        now: Math.floor(Date.now() / 1000),
      });
      return send(res, 200, plan);
    } catch (err) {
      return send(res, err instanceof PlanRefused ? 400 : 502, { error: (err as Error).message });
    }
  }
  if (path === '/v1/hops' && q.get('recover') === 'true') {
    const waiting = deps.store.awaitingRecover().map((h) => ({ hop: h, key: journeyKeyOf(deps.store, h) }));
    const keys = [...new Set(waiting.map((w) => w.key).filter((k) => k !== null))];
    const hops = [
      ...keys.map((k) => journeyOf(deps, k)).filter((j) => j !== undefined),
      ...waiting.filter((w) => w.key === null).map((w) => unkeyedHop(deps, w.hop)),
    ];
    return send(res, 200, { hops, count: hops.length });
  }
  if (path === '/v1/hops') {
    const keys = !deps.cfg.savanna.accounts.hop ? [] : deps.store.hopDeposits({
      hop: deps.cfg.savanna.accounts.hop,
      party: q.get('party') ?? undefined,
      before: intParam(q, 'before', 0, Number.MAX_SAFE_INTEGER),
      limit: intParam(q, 'limit', 1, 500),
    });
    const hops = keys.map((k) => journeyOf(deps, k)).filter((j) => j !== undefined);
    return send(res, 200, { hops, count: hops.length });
  }
  if (path === '/v1/activity') {
    const limit = intParam(q, 'limit', 1, 100) ?? 25;
    const state = q.get('state');
    if (state && !(STATES as readonly string[]).includes(state)) {
      return send(res, 400, { error: `state is one of ${STATES.join(', ')}` });
    }
    const filter = {
      chain: q.get('chain') ?? undefined,
      asset: q.get('asset') ?? undefined,
      state: (state as ActivityState | null) ?? undefined,
      party: q.get('party') ?? undefined,
    };
    try {
      return send(res, 200, feed(await activitySoon(deps), filter, limit, q.get('cursor') ?? undefined), 15);
    } catch (err) {
      return send(res, 400, { error: (err as Error).message });
    }
  }
  if (path === '/v1/activity/summary') {
    const period = q.get('period') ?? 'all';
    if (!Object.hasOwn(PERIODS, period)) {
      return send(res, 400, { error: `period is one of ${Object.keys(PERIODS).join(', ')}` });
    }
    return send(res, 200, await summarySoon(deps, period as Period), 30);
  }
  if (path === '/v1/reserves') {
    const out = await reservesSoon(deps);
    // A partial answer is not for a cache to hold: the next request may well read everything.
    return send(res, 200, out, complete(out.assets) ? 60 : undefined);
  }
  if (path === '/v1/finalizer-keys') {
    const keys = await finalizerKeys(deps.cfg);
    const chain = q.get('chain');
    return send(res, 200, chain ? { ...keys, chains: keys.chains.filter((c) => c.chain === chain) } : keys);
  }
  if (path === '/v1/upkeep') {
    const u = await upkeep(deps.cfg, deps.store);
    const chain = q.get('chain');
    return send(res, 200, chain
      ? { ...u, todo: u.todo.filter((t) => t.chain === chain), chains: u.chains.filter((c) => c.chain === chain) }
      : u);
  }
  if (path === '/v1/pending') {
    return send(res, 200, await pending(deps, {
      account: q.get('account') ?? undefined,
      address: q.get('address') ?? undefined,
      chain: q.get('chain') ?? undefined,
      readyOnly: q.get('ready') === 'true',
    }));
  }

  if (path === '/v1/transfers') {
    const rows = deps.store.listTransfers({
      account: q.get('account') ?? undefined,
      address: q.get('address') ?? undefined,
      direction: (q.get('direction') as any) ?? undefined,
      status: q.get('status') ?? undefined,
      before: intParam(q, 'before', 0, Number.MAX_SAFE_INTEGER),
      limit: intParam(q, 'limit', 1, 500),
    });
    const decorated = rows.map((r) => decorate(deps, r));
    const filtered = q.get('flag')
      ? decorated.filter((r) => r.flags.includes(q.get('flag')!))
      : decorated;
    return send(res, 200, { transfers: filtered, count: filtered.length });
  }

  let m = /^\/v1\/transfers\/(.+)$/.exec(path);
  if (m) {
    const row = deps.store.getTransfer(decodeURIComponent(m[1]));
    if (!row) return send(res, 404, { error: 'no such transfer' });
    return send(res, 200, decorate(deps, row));
  }

  m = /^\/v1\/hops\/(.+)$/.exec(path);
  if (m) {
    const found = journeyOf(deps, decodeURIComponent(m[1]));
    if (!found) return send(res, 404, { error: 'no such deposit' });
    return send(res, 200, found);
  }

  m = /^\/v1\/accounts\/([^/]+)\/transfers$/.exec(path);
  if (m) {
    const account = decodeURIComponent(m[1]);
    const rows = deps.store.listTransfers({
      account,
      limit: intParam(q, 'limit', 1, 500),
      before: intParam(q, 'before', 0, Number.MAX_SAFE_INTEGER),
    });
    return send(res, 200, { account, transfers: rows.map((r) => decorate(deps, r)) });
  }

  m = /^\/v1\/accounts\/([^/]+)$/.exec(path);
  if (m) return send(res, 200, await account(deps, decodeURIComponent(m[1])));

  m = /^\/v1\/proofs\/(.+)$/.exec(path);
  if (m) {
    const { code, body } = await proof(deps, decodeURIComponent(m[1]));
    return send(res, code, body);
  }

  // A finality-tree branch for any block still in the leaf window: the root as of
  // that block and the path to its leaf. A Telos -> Antelope relayer folds a withdrawal
  // into the root a proved header carries, and checks the root itself.
  m = /^\/v1\/savanna\/branch\/(\d+)$/.exec(path);
  if (m) {
    const block = Number(m[1]);
    try {
      const local = treeThrough(deps.cfg.checkpointDir, deps.savanna.leafStore, block, block);
      const leaf = deps.savanna.leafStore.read(block)!;
      const steps = local.tree.proof(leaf, local.root);
      return send(res, 200, { block, root: local.root, leaf: Buffer.from(leaf).toString('hex'), steps });
    } catch (err) {
      return send(res, 404, { error: (err as Error).message });
    }
  }

  // A legacy chain's blockroot keeper (`/v1/wax`, `/v1/xpr`) and the merkle as
  // it stood at any block it holds, which is what its relayer signs against.
  m = /^\/v1\/([a-z]+)(?:\/blockroot\/(\d+))?$/.exec(path);
  const keeper = m ? deps.keepers.get(m[1]) : undefined;
  if (m && keeper) {
    if (m[2] === undefined) return send(res, 200, keeper.snapshot());
    try {
      return send(res, 200, keeper.stateAt(Number(m[2])));
    } catch (err) {
      return send(res, 404, { error: (err as Error).message });
    }
  }

  send(res, 404, { error: `no route for ${raw}` });
}

// --- health and stats --------------------------------------------------------------

/** A deposit held this long is an incident rather than a hiccup. */
const HELD_ALARM_SECONDS = 3600;

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
    return `#${row.ref} ${amount} ${row.direction === 'deposit' ? 'from' : 'to'} ${ctx.chainName(row.domain)}`;
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

async function account(deps: Deps, name: string) {
  const rows = deps.store.listTransfers({ account: name, limit: 500 });
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.status] = (counts[r.status] ?? 0) + 1;
  const decorated = rows.map((r) => decorate(deps, r));

  // A credit issues to the bridge and records what the beneficiary may collect;
  // collecting is a separate act. Saying "credited" without saying whether it
  // was picked up tells half of it, and the half a user acts on is this one.
  let claimable: { symbol: string; amount: string; precision: number | null }[] = [];
  try {
    const rowsOut = await getTableRows<{ balance: string }>(deps.cfg.savanna, {
      code: deps.cfg.savanna.accounts.bridge,
      scope: name,
      table: 'claims',
    });
    claimable = rowsOut.map((r) => {
      // `"0.01000000 ETH"` -> 1000000 at precision 8, as a decimal string: the
      // front end compares strings, and `001000000` is not `1000000`.
      const { units, symbol, precision } = parseAsset(String(r.balance));
      return { symbol, amount: units.toString(), precision };
    });
  } catch {
    // The chain not answering is not a reason to fail the whole page.
  }

  return {
    account: name,
    counts,
    open: decorated.filter((r) => !SETTLED.includes(r.status)).length,
    needsAttention: decorated.filter((r) => r.flags.length).length,
    claimable,
    claims: deps.store.claimsOf(name, 10),
    transfers: decorated.slice(0, 50),
  };
}

// --- what needs pushing -----------------------------------------------------------------

/** RAM moves by a few hundred bytes a crossing; a minute between reads misses nothing. */
let ramMemo: (() => Promise<RamRow[]>) | undefined;

function ramSoon(deps: Deps): Promise<RamRow[]> {
  ramMemo ??= memo(60_000, () => ramReport(deps.cfg));
  return ramMemo();
}

/**
 * Committee status is two network calls and both `/health` and `/v1/pending`
 * are polled, so the answer is held for a minute — far shorter than the 27
 * hours a rotation takes, so nothing is missed by not asking again.
 */
let committeeMemo: (() => ReturnType<typeof committeeStatus>) | undefined;

function committeeSoon(deps: Deps): ReturnType<typeof committeeStatus> {
  committeeMemo ??= memo(60_000, () => committeeStatus(deps.cfg.savanna, new BeaconClient(deps.cfg.beaconUrls[0])));
  return committeeMemo();
}

/**
 * Where a withdrawal settles, taken from the withdrawal rather than from this
 * process's configuration.
 *
 * The Telos half of an instance is shared by every route: it follows one bridge
 * contract, and that contract's withdrawal table holds crossings bound for every
 * chain there is a route to. So one Savanna follower serves them all — nothing
 * about a finality proof is chain-specific — and the only per-chain facts are the
 * two addresses the proof is pushed to.
 *
 * Reading those off `cfg.evm` was the bug: an instance configured for Sepolia
 * labelled a BSC withdrawal with Sepolia's verifier. The proof was right, the
 * envelope was wrong, and the wrong envelope is the kind that reverts far away
 * from the mistake — or, on a chain that happens to have a contract at the same
 * address, does not revert at all.
 */
function settlementTarget(domain: number | string | undefined, vault?: string) {
  const chainId = Number(domain);
  const chain = Object.values(EVM_CHAINS).find((c) => c.chainId === chainId);
  // A withdrawal names its vault, and only that vault's releaser accepts it. One
  // burned before a vault was replaced belongs to the old one, which the
  // registry no longer points at: say so rather than hand out a doomed call.
  const otherVault = chain?.vault && vault && chain.vault.toLowerCase() !== vault.toLowerCase();
  return {
    id: chain?.id ?? null,
    chainId: Number.isSafeInteger(chainId) ? chainId : null,
    lightClient: chain?.lightClient ?? null,
    withdrawals: chain?.withdrawals ?? null,
    /** Set when this build cannot say where the proof settles. */
    unknown: !chain
      ? `no chain with id ${domain} in the registry`
      : otherVault
        ? `withdrawal is for vault ${vault}; the registry's vault on this chain is ${chain!.vault}`
        : undefined,
  };
}

export type PendingPush = {
  key: string;
  direction: string;
  /** The action a wallet would sign, in words. */
  action: string;
  /** Which chain it goes to: `telos`, or a far chain by its registry id. */
  pushOn: string;
  /** True when the proof is stored and the transaction can be built right now. */
  ready: boolean;
  reason: string;
  proof: string | null;
  account: string | null;
  evmAddress: string | null;
  amount: string | null;
  /** What `amount` is in, on a transfer's item; null for a token this build has no listing for. */
  symbol?: string | null;
  precision?: number | null;
  /** Set when there is a clock on it. */
  deadline?: { at: number; secondsLeft: number; what: string };
  /** For an operator rather than a user. */
  admin?: boolean;
};

/**
 * Everything that is currently waiting for somebody to sign a transaction.
 *
 * This is the whole point of an observer that does not push: it knows exactly
 * what is outstanding, on which chain, and whether the proof for it already
 * exists — so a user can finish their own crossing and an operator can see the
 * queue, without either of them holding a key this service also holds.
 *
 * `ready: false` items are listed too, with the reason. A deposit waiting for
 * finality is not a problem; a deposit waiting for finality that has been
 * waiting nine hours is, and only listing the ready ones hides it.
 */
async function pending(
  deps: Deps,
  filter: { account?: string; address?: string; chain?: string; readyOnly?: boolean },
): Promise<{ pending: PendingPush[]; count: number; asOf: number }> {
  const now = Math.floor(Date.now() / 1000);
  const out: PendingPush[] = [];

  const rows = deps.store.listTransfers({
    account: filter.account,
    address: filter.address,
    limit: 500,
  });

  for (const r of rows) {
    const d = decorate(deps, r);
    const far = chainOfDomain(deps.cfg, r.domain);
    // Who and how much, the same on every transfer's item.
    const transfer = {
      account: r.account,
      evmAddress: r.evm_address,
      amount: r.amount,
      symbol: d.symbol,
      precision: d.precision,
    };

    if (r.direction === 'deposit' && BOOKED.includes(r.status)) continue;

    // A deposit from an Antelope chain is proved by that chain's relayer, not
    // pushed from here: there is no proof to offer, no fast path and no
    // ancestry deadline — only how far its producers have got.
    if (r.direction === 'deposit' && (far?.kind === 'antelope' || far?.kind === 'sui' || far?.kind === 'near')) {
      out.push({
        key: r.key,
        direction: 'deposit',
        action: `proved by the ${far.chain.name} relayer`,
        pushOn: SETTLEMENT_CHAIN,
        ready: false,
        reason: d.progress.stage,
        proof: null,
        ...transfer,
      });
      continue;
    }

    if (r.direction === 'deposit') {
      // Whether the fast proof is on offer, from numbers already in hand: the
      // EVM head and the route's limits. Building one to find out would be a
      // beacon round trip per row per poll.
      const fast = await fastReady(deps, r);
      const ready = d.hasProof || fast.ready;
      // The deposit side's own deadline, and on a beacon chain the tight one.
      const expires = ready ? undefined : ancestryDeadline(deps.cfg, r);
      out.push({
        key: r.key,
        direction: 'deposit',
        action: fast.ready
          ? `proveroot + credit (fast, ${fast.confirmations} confirmations)`
          : d.hasProof
            ? 'proveroot + credit (finalized)'
            : 'waiting',
        pushOn: SETTLEMENT_CHAIN,
        ready,
        reason: fast.ready
          ? 'enough confirmations proved for this route; it can be credited now'
          : d.hasProof
            ? 'proved and not yet credited on the settlement chain'
            : fast.reason,
        proof: ready ? `/v1/proofs/${r.key}` : null,
        ...transfer,
        ...(expires === undefined
          ? {}
          : {
              deadline: {
                at: expires,
                secondsLeft: expires - now,
                what: 'after this the ancestry no longer fits in one transaction',
              },
            }),
      });
      continue;
    }

    if (r.status === 'released' || r.status === 'refunded') continue;

    // Bound for an Antelope chain: its relayer releases it — or expires it
    // past the deadline — with a proof of its own, so nothing here is pushed
    // by anyone else and no EVM artifact is ever stored for it.
    if (far?.kind === 'antelope') {
      out.push({
        key: r.key,
        direction: 'withdrawal',
        action: `released by the ${far.chain.name} relayer`,
        pushOn: far.chain.id,
        ready: false,
        reason: d.progress.stage,
        proof: null,
        ...transfer,
      });
      continue;
    }

    // Rolled back on the far side: what is outstanding is the refund at home,
    // and it needs the vault's `Voided` log proved on the settlement chain.
    if (r.status === 'expired' && (far?.kind === 'sui' || far?.kind === 'near')) {
      out.push({
        key: voidKey(r.ref),
        direction: 'withdrawal-rollback',
        action: `reissued by the ${far.chain.name} relayer`,
        pushOn: SETTLEMENT_CHAIN,
        ready: false,
        reason: far.kind === 'sui'
          ? 'expired on Sui; the relayer proves the Voided event and the burned amount is reissued'
          : `expired on ${far.chain.name}; the relayer proves the voided log and the burned amount is reissued`,
        proof: null,
        ...transfer,
      });
      continue;
    }
    if (r.status === 'expired') {
      const vk = voidKey(r.ref);
      const ready = deps.store.hasProof(vk);
      out.push({
        key: vk,
        direction: 'withdrawal-rollback',
        action: ready ? 'proveroot + voided' : 'waiting for finality',
        pushOn: SETTLEMENT_CHAIN,
        ready,
        reason: ready
          ? 'voided on the far side; the burned amount can be reissued'
          // The Voided log is on the FAR side, so this is that chain's
          // finality and not ours — seconds on BSC, a quarter hour on Ethereum.
          : `the Voided log has not finalized yet — ${proofWait(deps, r)}`,
        proof: ready ? `/v1/proofs/${vk}` : null,
        ...transfer,
      });
      continue;
    }

    const pastDeadline = r.deadline !== null && r.deadline <= now;
    out.push({
      key: r.key,
      direction: pastDeadline ? 'withdrawal-expire' : 'withdrawal',
      action: far?.kind === 'sui'
        ? (pastDeadline ? 'submit_root_entry + expire_entry' : 'submit_root_entry + release_entry')
        : far?.kind === 'near'
          ? (pastDeadline ? 'submit_root + expire' : 'submit_root + release')
          : pastDeadline
          ? 'expire'
          : d.track === 'light'
            ? 'release (~135k gas)'
            : 'submitRoot + release (~2.6M gas)',
      // The chain the withdrawal is BOUND FOR, from the row's own domain —
      // not this instance's own chain. With one source they were the same
      // string, which is exactly why it went unnoticed; with four, a BSC
      // withdrawal was being labelled `sepolia`.
      pushOn: far?.chain.id ?? `domain ${r.domain}`,
      ready: d.hasProof,
      reason: pastDeadline
        ? 'past its deadline: release is refused, expire is what unlocks the refund'
        : d.hasProof
          ? 'burned and not yet released'
          : 'burned, and no proof is stored — this is the one with a clock on it',
      proof: d.hasProof ? `/v1/proofs/${r.key}` : null,
      ...transfer,
      ...(r.deadline && !pastDeadline
        ? {
            deadline: {
              at: r.deadline,
              secondsLeft: r.deadline - now,
              what: 'after this only expire is possible, not release',
            },
          }
        : {}),
    });
  }

  // The operator's item. Not a transfer, and the one rotation that cannot skip:
  // a committee is only provable by the one before it, so a backlog has to be
  // walked one period at a time before beacon nodes prune the updates.
  if (!filter.account && !filter.address && deps.cfg.evm.strategy === 'parlia') {
    const e = await epochBacklog(deps.cfg).catch(() => null);
    if (e && e.lag > 0) {
      out.push({
        key: `vsets:${e.stored + (deps.cfg.evm.epochLength ?? 0)}`,
        direction: 'validators',
        action: `updateset × ${e.lag}`,
        pushOn: SETTLEMENT_CHAIN,
        ready: true,
        reason:
          `the light client holds epoch ${e.stored} and the chain is on ${e.head}. ` +
          `Sets are chained and cannot be jumped; install them in order with updateset`,
        proof: null,
        account: null,
        evmAddress: null,
        amount: null,
        admin: true,
      });
    }
  }

  if (!filter.account && !filter.address && deps.cfg.evm.strategy === 'beacon') {
    const c = await committeeSoon(deps).catch(() => null);
    if (c && c.lagPeriods > 0) {
      out.push({
        key: `committee:${c.stored + 1}`,
        direction: 'committee',
        action: `updcommit × ${c.lagPeriods}`,
        pushOn: SETTLEMENT_CHAIN,
        ready: true,
        reason:
          `the light client holds period ${c.stored} and the chain is on ${c.head}. ` +
          `Rotations cannot be skipped; push updcommit once per period`,
        proof: null,
        account: null,
        evmAddress: null,
        amount: null,
        admin: true,
      });
    }
  }

  // A finalizer key a withdrawal chain has never seen. Not an operator's item:
  // anyone may register it, and until someone does, every certificate that
  // finalizer signs is refused there, so every withdrawal to that chain waits.
  if (!filter.account && !filter.address) {
    const keys = await finalizerKeys(deps.cfg).catch(() => null);
    for (const c of keys?.chains ?? []) {
      for (const k of c.missing.filter((m) => m.inPolicy)) {
        out.push({
          key: `finkey:${c.chain}:${k.keyId}`,
          direction: 'finalizer-key',
          action: 'registerKey',
          pushOn: c.chain,
          ready: true,
          reason:
            `${k.finalizer} finalizes Telos and ${c.name}'s light client does not know its key: ` +
            `withdrawals there fail until it is registered. Anyone may, about ${k.registerKey.gas.toLocaleString('en-US')} gas`,
          proof: `/v1/finalizer-keys?chain=${c.chain}`,
          account: null,
          evmAddress: null,
          amount: null,
        });
      }
    }
  }

  const filtered = out.filter(
    (p) => (!filter.readyOnly || p.ready) && (!filter.chain || p.pushOn === filter.chain),
  );
  return { pending: filtered, count: filtered.length, asOf: now };
}

// --- one transfer, as a UI wants it ---------------------------------------------------

export type DecoratedTransfer = TransferRow & {
  flags: string[];
  hasProof: boolean;
  /** Which settlement track a proof request would return, without asking for it. */
  track: 'light' | 'hard' | null;
  secondsToDeadline: number | null;
  /** What `amount` is denominated in. Without it the number means nothing. */
  precision: number | null;
  /** The far chain, by its registry id: `mainnet`, `wax`. Null for a domain this build does not know. */
  chain: string | null;
  /**
   * The token, ready to show: the symbol and its decimals, and where it lives
   * over there — an ERC-20 address, or an Antelope (contract, symbol) pair.
   */
  asset: { symbol: string; precision: number; address?: string; contract?: string } | null;
  /** `amount` with its decimals and symbol: `20 WAX`, `0.001 ETH`. Null until the token is known. */
  amountHuman: string | null;
  /** This row as one leg of a hop between two chains; null for a crossing that ends on Telos. */
  hop: HopLink | null;
  /**
   * The swap its payout made at the far end — `delivered as 4033.1234 TLM`,
   * `refunded as 50.000000 USDC` — when it was paid out to bridgeroute; null otherwise.
   */
  swap: SwapView | null;
  /** How far it has got: stage, percent, ETA, and whether the next step waits on the user. */
  progress: Progress;
};

/**
 * Add what a chain row cannot say.
 *
 * `flags` is the part a UI actually renders: `stuck`, `past-deadline`,
 * `unprovable`. They are computed rather than stored because they are functions
 * of the clock, and a stored one would be stale the moment it was written.
 */
function decorate(deps: Deps, row: TransferRow): DecoratedTransfer {
  const now = Math.floor(Date.now() / 1000);
  const hasProof = deps.store.hasProof(row.key);
  const flags: string[] = [];

  const settled = SETTLED.includes(row.status);
  const secondsToDeadline = row.deadline ? row.deadline - now : null;

  const far = chainOfDomain(deps.cfg, row.domain);
  if (row.direction === 'withdrawal' && !settled) {
    // An EVM release needs the artifact frozen here; an Antelope chain's relayer proves its own.
    if (!hasProof && far?.kind !== 'antelope') flags.push('unfrozen');
    if (secondsToDeadline !== null && secondsToDeadline <= 0) flags.push('past-deadline');
  }
  if (row.direction === 'deposit' && row.status === 'provable' && now - (row.proof_at ?? now) > DEPOSIT_STUCK_SECONDS) {
    flags.push('stuck');
  }
  if (row.status === 'expired') flags.push('rolled-back');
  const hold = holdOf(row, holdContext(deps));
  if (hold) flags.push(hold.flag);

  let track: 'light' | 'hard' | null = null;
  if (hasProof && row.direction === 'withdrawal') {
    const covering = rootCovering(deps, row, row.src_block);
    track = covering && inWindow(deps, covering.block) ? 'light' : 'hard';
  }

  // `amount` is an integer in canonical units, and the same integer is 0.01 ETH
  // on one route and 1.0 ATUSD on another. The symbol the bridge issues carries
  // the precision, so it travels with every row rather than being guessed at.
  const listed = assetFor(row.token, row.domain);
  const asset = listed
    ? {
        symbol: listed.symbol,
        precision: listed.precision,
        ...(far?.kind === 'antelope'
          ? { contract: antelopeToken(row.token ?? '')?.contract }
          : far?.kind === 'sui' || far?.kind === 'near'
            ? { token: row.token ?? undefined }
            : { address: row.token ?? undefined }),
      }
    : null;
  const chain = far?.chain.id ?? null;

  return {
    ...row,
    symbol: asset?.symbol ?? row.symbol,
    precision: asset?.precision ?? null,
    chain,
    asset,
    amountHuman: asset && row.amount !== null ? humanAmount(row.amount, asset.precision, asset.symbol) : null,
    flags,
    hasProof,
    track,
    secondsToDeadline,
    hop: hopLink(deps.store, row, (domain) => chainOf(deps, domain)),
    swap: swapOfPayout(deps.store, row.dst_tx),
    progress: transferProgress(row, progressContext(deps)),
  };
}

/** What `progress` is read against: the followers' heads, the listed routes, the measured timings. */
function progressContext(deps: Deps): ProgressContext {
  const of = (domain: string | null) => chainOfDomain(deps.cfg, domain);
  return {
    now: Math.floor(Date.now() / 1000),
    evmHead: (domain) => followerOf(deps, domain)?.state.head || undefined,
    route: routeLimits,
    chainName: (domain) => of(domain)?.chain.name ?? 'the far chain',
    // A Sui or NEAR deposit, like an Antelope one, is proved by its relayer.
    isAntelope: (domain) => ['antelope', 'sui', 'near'].includes(of(domain)?.kind ?? ''),
    depositEta: (domain) => {
      const far = of(domain);
      if (!far) return null;
      if (far.kind === 'sui') return suiDepositEta(far.chain);
      if (far.kind === 'near') return nearDepositEta(far.chain);
      return far.kind === 'antelope' ? antelopeDepositEta(far.chain) : depositEta(far.chain);
    },
    withdrawalEta: (domain) => {
      const far = of(domain);
      if (!far) return null;
      if (far.kind === 'sui') return suiWithdrawalEta(far.chain);
      if (far.kind === 'near') return nearWithdrawalEta(far.chain);
      return far.kind === 'antelope' ? antelopeWithdrawalEta(far.chain) : withdrawalEta(far.chain);
    },
    hold: (row) => holdOf(row, holdContext(deps)),
  };
}

/**
 * Each EVM vault's daily outflow per token, as the last `/v1/chains` read it:
 * keyed `<chain id>:<token>`, null for a token with no limit. A row renders
 * synchronously, so it reads what is known rather than waiting on a vault.
 */
const outflows = new Map<string, Outflow | null>();

const bareToken = (token: string) => token.replace(/^0x/, '').toLowerCase();

function rememberOutflows(sources: { chainId?: number | string; routes?: any[] }[]): void {
  for (const source of sources) {
    if (source.chainId === undefined) continue;
    for (const r of source.routes ?? []) {
      if (r.outflowError || r.outflowLeft === undefined || !r.token) continue;
      outflows.set(
        `${source.chainId}:${bareToken(r.token)}`,
        r.outflowLeft === null ? null : { left: BigInt(r.outflowLeft), perDay: BigInt(r.outflowPerDay) },
      );
    }
  }
}

/** What `holds.ts` reads a row against: the ledger's routes and the vaults' daily limits. */
function holdContext(deps: Deps): HoldContext {
  return {
    now: Math.floor(Date.now() / 1000),
    route: routeRoom,
    outflow: (token, domain) => (token && domain !== null ? outflows.get(`${domain}:${bareToken(token)}`) : undefined),
    chainName: (domain) => chainOfDomain(deps.cfg, domain)?.chain.name ?? 'the far chain',
  };
}

// --- activity -------------------------------------------------------------------------

/**
 * Every transfer, hops folded into one, shared for fifteen seconds: the feed is
 * public and every page view asks for it, while a crossing takes minutes.
 */
let activityMemo: (() => Promise<Activity[]>) | undefined;
function activitySoon(deps: Deps): Promise<Activity[]> {
  activityMemo ??= memo(15_000, async () => activities(deps.store, {
    hop: deps.cfg.savanna.accounts.hop,
    chainOf: (domain) => chainOf(deps, domain),
    asset: assetFor,
    progress: progressContext(deps),
  }));
  return activityMemo();
}

/** The summary of one period, over the shared feed, for half a minute. */
const summaryMemos = new Map<Period, () => Promise<ActivitySummary>>();
function summarySoon(deps: Deps, period: Period) {
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
function reservesSoon(deps: Deps) {
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

// --- hops -----------------------------------------------------------------------------

/**
 * A voided hop no deposit started: bridgeroute's delivery of a swap to another
 * chain, or that delivery's way back. Only what recovering it needs — the leg,
 * and the action — in the shape a journey's last leg has, keyed by its
 * withdrawal.
 */
function unkeyedHop(deps: Deps, hop: HopRow) {
  return {
    key: withdrawalKey(hop.id),
    legs: [{ key: withdrawalKey(hop.id), returning: hop.prev !== null, quantity: hop.quantity,
             to: { domain: hop.to_domain, recipient: hop.to_recipient, chain: chainOf(deps, hop.to_domain) } }],
    recover: { account: deps.cfg.savanna.accounts.hop!, name: 'recover', data: { id: String(hop.id) } },
  };
}

/** One journey through the hop contract, keyed by the deposit that started it. */
function journeyOf(deps: Deps, key: string) {
  return journey(deps.store, key, (row) => decorate(deps, row), (domain) => chainOf(deps, domain),
    deps.cfg.savanna.accounts.hop, progressContext(deps));
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
function status(deps: Deps) {
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
function routes(deps: Deps): Promise<unknown[]> {
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

const inWindow = (deps: Deps, block: number): boolean => {
  const first = deps.savanna.leafStore.firstBlock;
  const last = deps.savanna.leafStore.lastBlock;
  return first !== undefined && last !== undefined && block >= first && block <= last;
};

// --- proofs ---------------------------------------------------------------------------

/** What `/v1/proofs/<key>` answers: a status code and the body. */
type Answer = { code: number; body: Record<string, unknown> };

/** A proof pushed on the settlement chain: a deposit's credit, or a void's refund. */
type SettledKind = 'deposit' | 'void';

/**
 * Everything needed to finish a crossing, in the shape the chain takes.
 *
 * For a withdrawal that is two possible answers, and the choice is made here
 * rather than by the caller:
 *
 *   light   fold into a root somebody already made trusted — one transaction,
 *           ~135k gas. Offered only when the branch was rebuilt and checked.
 *   hard    submit this withdrawal's own root first, then release — ~2.6M gas.
 *           Always available, because the artifact carries both halves.
 *
 * For a deposit or a void it is one answer per proof strategy, each below. This
 * function only finds the row the proof belongs to — which is where its chain is
 * recorded — and picks.
 */
async function proof(deps: Deps, key: string): Promise<Answer> {
  const stored = deps.store.getProof(key);
  const row = transferOf(deps, key, stored?.kind);
  if (!row) return { code: 404, body: { error: 'no such transfer' } };
  if (!stored) return proofOnDemand(deps, row);
  if (stored.kind === 'withdrawal') {
    const artifact = JSON.parse(stored.body);
    const far = chainOfDomain(deps.cfg, row.domain);
    if (far?.kind === 'sui') return suiWithdrawalProof(deps, row, artifact);
    if (far?.kind === 'near') return nearWithdrawalProof(deps, row, artifact);
    return withdrawalProof(deps, row, artifact);
  }

  const kind = stored.kind as SettledKind;
  const body = JSON.parse(stored.body);
  const source = chainOfDomain(deps.cfg, row.domain);
  if (source?.kind !== 'evm') {
    return { code: 404, body: { error: `domain ${row.domain} is not a source chain this instance follows` } };
  }
  if (body.strategy === 'milestone') return milestoneProof(deps, key, kind, row, source, body);
  if (body.strategy === 'parlia') return parliaProof(deps, key, kind, source, body);
  return beaconProof(deps, key, kind, row, source, body);
}

/**
 * The transfer a proof belongs to, which is where its chain is recorded.
 *
 * A void is proved under `v:<id>` but has no row of its own: it rolls back the
 * withdrawal `w:<id>`. Looked up under its own key it found nothing, the chain
 * came out unknown, and the Ethereum contracts were named instead — right for a
 * Sepolia void by accident, and a BSC void was sent to `ethlightclnt`.
 */
function transferOf(deps: Deps, key: string, kind: string | undefined) {
  return deps.store.getTransfer(kind === 'void' ? withdrawalKey(key.slice(2)) : key);
}

/** What every settlement-chain proof starts with. */
const proofHead = (key: string, kind: SettledKind, blockNumber: number) => ({
  key,
  kind,
  direction: kind === 'deposit' ? 'deposit' : 'withdrawal-rollback',
  pushOn: SETTLEMENT_CHAIN,
  blockNumber,
});

/**
 * The gateway action a proof ends with. Same machinery, same argument shape;
 * only the action differs: `credit` turns a Deposit log into wrapped tokens,
 * `voided` turns a Voided log into a refund of what was burned, and the `cp`
 * pair takes either through a Polygon checkpoint instead of a milestone.
 */
function gatewayAction(kind: SettledKind, viaCheckpoint: boolean): string {
  if (viaCheckpoint) return kind === 'deposit' ? 'creditcp' : 'voidedcp';
  return kind === 'deposit' ? 'credit' : 'voided';
}

/**
 * Nothing frozen yet — but a deposit's fast proof is built on demand and is
 * available ten minutes before the finalized one exists. That window is the
 * whole point of the fast path, so 404 would be the wrong answer in it.
 */
async function proofOnDemand(deps: Deps, row: TransferRow): Promise<Answer> {
  if (row.direction !== 'deposit' || BOOKED.includes(row.status)) {
    return { code: 404, body: { error: 'no proof stored for this transfer yet', status: row.status } };
  }
  const fast = await fastPart(deps, row, 'credit');
  if (!fast.fast) {
    return { code: 404, body: { error: 'no proof available yet', status: row.status, fastUnavailable: fast.fastUnavailable ?? null } };
  }
  return {
    code: 200,
    body: {
      ...proofHead(row.key, 'deposit', row.src_block),
      ...fast,
      // Per chain, not thirteen minutes: the same sentence used to quote
      // Ethereum's finality at someone depositing on BSC, where it is seconds.
      finalizedPending: `the finalized proof is frozen once the block finalizes — ${proofWait(deps, row)}`,
    },
  };
}

/**
 * Polygon, built here, now: its Heimdall commit has to be from the exact set
 * polylightcl holds at the moment it is pushed, and that set moves about
 * hourly. Only the receipt was frozen.
 */
async function milestoneProof(
  deps: Deps, key: string, kind: SettledKind, row: TransferRow, source: EvmDomain, body: any,
): Promise<Answer> {
  const gateway = withPayer(deps, body.gateway);
  try {
    const built = await polygonProveroot(source.chain, deps.cfg.savanna, source.accounts.lightClient, payerFor(deps, body.gateway[0]), body.blockNumber);
    return {
      code: 200,
      body: {
        ...proofHead(key, kind, body.blockNumber),
        track: 'finalized',
        finalized: {
          note: 'built now, under the validator set the light client holds; push it soon — the set moves about hourly',
          signedBy: built.signedBy,
          milestone: built.milestone.number,
          heimdallHeight: built.heimdallHeight,
          actions: [
            { account: source.accounts.lightClient, name: 'proveroot', data: [...built.args] },
            { account: source.accounts.gateway, name: gatewayAction(kind, false), data: gateway },
          ],
        },
      },
    };
  } catch (err) {
    return { code: 404, body: { error: 'no proof available yet', status: row.status, reason: (err as Error).message } };
  }
}

/**
 * A Parlia proof carries its own keys — all of the epoch's set, in two
 * kilobytes — so there is no committee to stitch back in, and no fast track to
 * attach: every row its light client writes is already final.
 */
function parliaProof(deps: Deps, key: string, kind: SettledKind, source: EvmDomain, body: any): Answer {
  return {
    code: 200,
    body: {
      ...proofHead(key, kind, body.blockNumber),
      track: 'finalized',
      finalized: {
        note: 'BSC finalizes in about a second; this proof is final and cannot go stale',
        signedBy: body.signedBy,
        epoch: body.epoch,
        finalizedBy: body.finalizedBy,
        actions: [
          { account: source.accounts.lightClient, name: 'proveroot', data: withPayer(deps, body.proveroot) },
          { account: source.accounts.gateway, name: gatewayAction(kind, false), data: withPayer(deps, body.gateway) },
        ],
      },
    },
  };
}

/**
 * A sync-committee proof: Ethereum's own, or a Polygon checkpoint proved through
 * Ethereum's state. The committee is stored once per period and stitched back in
 * here.
 *
 * A Polygon deposit the milestone path did not close carries a checkpoint proof
 * (audit P-4): proved on the light client of the chain Polygon settles to, and
 * credited by the Polygon gateway's checkpoint action.
 */
async function beaconProof(
  deps: Deps, key: string, kind: SettledKind, row: TransferRow, source: EvmDomain, body: any,
): Promise<Answer> {
  const committee = deps.store.getCommittee(body.committeePeriod);
  if (!committee) {
    return { code: 500, body: { error: `committee for period ${body.committeePeriod} is missing from storage` } };
  }
  const viaCheckpoint = body.fallback === 'checkpoint';
  const lightClient = viaCheckpoint
    ? deps.cfg.sources.find((s) => s.chain.id === source.chain.settlesTo)?.accounts.lightClient
    : source.accounts.lightClient;
  if (!lightClient) {
    return { code: 500, body: { error: `${source.chain.id} settles to ${source.chain.settlesTo}, which this instance does not follow` } };
  }
  const action = gatewayAction(kind, viaCheckpoint);
  const pr = { ...body.proveroot, keys: committee.keys, agg_key: committee.agg_key };
  return {
    code: 200,
    body: {
      ...proofHead(key, kind, body.blockNumber),
      track: 'finalized',
      finalized: {
        note: 'the chain can no longer abandon this block; never goes stale',
        signedBy: body.signedBy,
        ancestryHeaders: body.ancestry ?? null,
        actions: antelopeActions(deps, pr, body.gateway, action, { lightClient, gateway: source.accounts.gateway }),
      },
      // And the fast one, built now rather than read: an optimistic proof bakes
      // in its depth, so a stored one is worthless the moment a route asks for more.
      ...(await fastPart(deps, row, action)),
    },
  };
}

/** A withdrawal's release on its EVM chain: the hard track always, the light one when a trusted root folds it. */
function withdrawalProof(deps: Deps, row: TransferRow, artifact: WithdrawalArtifact): Answer {
  const target = settlementTarget((artifact.release as any)?.domain, artifact.vault);
  const out = {
    key: row.key,
    direction: 'withdrawal',
    // Null, with the warning, for a chain this build cannot name: labelling it
    // with this instance's own chain sent a front end to the wrong network.
    chain: target.id,
    ...(target.unknown ? { warning: target.unknown } : {}),
    burnBlock: artifact.burnBlock,
    rootBlock: artifact.rootBlock,
    vault: artifact.vault,
    status: row.status,
    deadline: row.deadline,
    hard: {
      gas: '~2.4M + 176k',
      // Two calls to two contracts, so both addresses travel with the proof: a
      // front end that had to hardcode one of them would hardcode the wrong one
      // the next time either is redeployed.
      submitRootTo: target.lightClient,
      releaseTo: target.withdrawals,
      submitRoot: frozenSubmitRoot(artifact.submitRoot),
      release: artifact.release,
    },
  };

  const covering = rootCovering(deps, row, artifact.burnBlock);
  if (!covering) return { code: 200, body: { ...out, track: 'hard', lightUnavailable: 'no trusted root covers this burn yet' } };
  if (!inWindow(deps, covering.block)) {
    return {
      code: 200,
      body: { ...out, track: 'hard', lightUnavailable: `leaves for block ${covering.block} are outside the retained window` },
    };
  }
  try {
    const moved = rebranch(deps.cfg.savanna, deps.cfg.checkpointDir, deps.savanna.leafStore, artifact, covering);
    return {
      code: 200,
      body: {
        ...out,
        light: {
          gas: '~135k',
          note: 'folds into a root already trusted on the far side; no submitRoot needed',
          rootBlock: covering.block,
          releaseTo: target.withdrawals,
          release: { ...artifact.release, ...moved },
        },
        track: 'light',
      },
    };
  } catch (err) {
    // Never serve a branch that did not fold. Falling back to the artifact is
    // more expensive and always correct.
    return { code: 200, body: { ...out, lightUnavailable: (err as Error).message, track: 'hard' } };
  }
}

/** A Sui vault read once a minute: its package, client and coins change only by an owner's hand. */
const suiVaults = new Map<string, { at: number; state: Promise<VaultState> }>();
function suiVaultSoon(graphql: string[], vault: string): Promise<VaultState> {
  const hit = suiVaults.get(vault);
  if (hit && Date.now() - hit.at < 60_000) return hit.state;
  const state = vaultState(graphql, vault);
  state.catch(() => suiVaults.delete(vault));
  suiVaults.set(vault, { at: Date.now(), state });
  return state;
}

/**
 * A withdrawal's release on Sui, as the Move calls a wallet makes: the root
 * first (`submit_root_entry`, a root already trusted is trusted again), then
 * `release_entry<coin>` before the deadline or `expire_entry` after it. Both in
 * one programmable transaction is the usual way.
 *
 * The client must know every signer and should seat the generation that signed:
 * when it is behind, `catchUp` names the handovers to walk first, each a
 * `submit_root_entry` and an `install_policy` (see `/v1/handovers`).
 */
async function suiWithdrawalProof(deps: Deps, row: TransferRow, artifact: WithdrawalArtifact): Promise<Answer> {
  const sui = deps.cfg.sui?.[0];
  if (!sui) return { code: 404, body: { error: 'this instance has no Sui endpoint (SUI_GRAPHQL)' } };
  const vault = await suiVaultSoon(sui.graphql, artifact.vault);
  const token = String((artifact.release as any).token).replace(/^0x/, '').toLowerCase();
  const coin = vault.assets.find((a) => a.token === token);
  if (!coin) return { code: 404, body: { error: `the vault ${artifact.vault} lists no coin with token ${token}` } };
  const client = await clientState(sui.graphql, vault.telosClient);
  const root = frozenSubmitRoot(artifact.submitRoot);
  const signing = Number(root.finality.activeGeneration);
  // The newest version of the vault's package: an upgrade retires the code before it.
  const ids = { package: vault.callPackage, telosClient: vault.telosClient, vault: vault.vault, coinType: '0x' + coin.coinType };
  return {
    code: 200,
    body: {
      key: row.key,
      direction: 'withdrawal',
      chain: sui.chain.id,
      burnBlock: artifact.burnBlock,
      rootBlock: artifact.rootBlock,
      vault: artifact.vault,
      status: row.status,
      deadline: row.deadline,
      sui: {
        ...ids,
        signingGeneration: signing,
        seatedGeneration: client.generation,
        catchUp: client.generation < signing ? `/v1/handovers?after=${client.generation}` : null,
        calls: {
          submitRoot: submitRootCall(ids.package, ids.telosClient, root),
          release: settleCall('release', ids, artifact),
          expire: settleCall('expire', ids, artifact),
        },
      },
    },
  };
}

/**
 * Telos's finalizer-policy handovers, stored as they happen: what a light
 * client that lags walks to catch up, oldest first. A generation whose
 * handover could not be built is missing from the list; the next one is
 * signed by it and still verifies against seats held from before.
 */
async function handovers(deps: Deps, after: number, limit: number) {
  // On an instance that shows Sui, each handover also as the two Move calls
  // that walk the Sui client over it.
  const sui = deps.cfg.sui?.length
    ? ((await status(deps)).sources as any[]).find((x) => x.kind === 'sui')?.contracts
    : undefined;
  // And on one that shows NEAR, as the two function calls on the vault (which holds its Telos client).
  const nearVault = await firstNearVault(deps);
  const rows = deps.store.handoversAfter(after, limit).map((h) => {
    const body = JSON.parse(h.body);
    return {
      ...body,
      ...(nearVault ? { nearCalls: handoverCalls(nearVault, body.submitRoot) } : {}),
      ...(sui?.package && sui.telosClient
        ? {
            suiCalls: [
              submitRootCall(sui.package, sui.telosClient, body.submitRoot),
              installPolicyCall(sui.package, sui.telosClient, body.submitRoot.pending.policy),
            ],
          }
        : {}),
    };
  });
  return { handovers: rows, count: rows.length };
}

/** The vault of the first NEAR chain this instance shows that the ledger routes to. */
async function firstNearVault(deps: Deps): Promise<string | undefined> {
  for (const near of deps.cfg.near ?? []) {
    const route = await nearRouteOf(deps.cfg, near.chain.domain).catch(() => undefined);
    if (route) return route.vault;
  }
  return undefined;
}

/**
 * Every key Telos ever registered, with its proof of possession, read from
 * history at most every ten minutes: a key new to Telos arrives about once a day.
 */
let registrations: { at: number; list: Promise<Registration[]> } | undefined;
function registrationsSoon(): Promise<Registration[]> {
  if (registrations && Date.now() - registrations.at < 600_000) return registrations.list;
  const list = fetchRegistrations(TELOS_HISTORY);
  list.catch(() => { registrations = undefined; });
  registrations = { at: Date.now(), list };
  return list;
}

/**
 * A withdrawal's settlement on NEAR, as the function calls a wallet sends to the
 * vault, in order (`near.calls`): `register_key` for each signer key the vault's
 * Telos client does not know yet (with its proof of possession from Telos's
 * `regfinkey` history), `submit_root` unless the root is already trusted, then
 * `release` before the deadline or `expire` after it.
 *
 * `release` names the recipient's account id, whose sha256 the withdrawal
 * carries. The indexer knows it when the vault's logs named that account (a
 * depositor, a refund address, an earlier recipient); otherwise `recipient` is
 * null in the call and the wallet puts in its own account id, which the vault
 * checks against `recipientAddress`.
 *
 * When the client seats an older generation than the one that signed, `catchUp`
 * names the handovers to walk first (`nearCalls` in `/v1/handovers`). A signer
 * key no history holds is listed in `unknownSigners`; the walk teaches it.
 */
async function nearWithdrawalProof(deps: Deps, row: TransferRow, artifact: WithdrawalArtifact): Promise<Answer> {
  const near = (deps.cfg.near ?? []).find((n) => n.chain.domain === String(row.domain));
  if (!near) return { code: 404, body: { error: 'this instance has no endpoint for that NEAR network (NEAR_RPC / NEAR_TESTNET_RPC)' } };
  const route = await nearRouteOf(deps.cfg, near.chain.domain);
  if (!route) return { code: 404, body: { error: `the ledger has no route to ${near.chain.name}` } };
  const vault = await nearVaultState(near.rpc, route.vault);
  const release = artifact.release as any;
  const token = String(release.token).replace(/^0x/, '').toLowerCase();
  const asset = vault.assets.find((a) => a.token === token);
  if (!asset) return { code: 404, body: { error: `the vault ${route.vault} lists no token with address ${token}` } };
  const recipientAddress = String(release.recipient).replace(/^0x/, '').toLowerCase();
  const recipient = deps.store.getMeta(nearAccountKey(recipientAddress)) ?? null;

  const root = frozenSubmitRoot(artifact.submitRoot);
  const signing = Number(root.finality.activeGeneration);
  // The signers: the keys of the signing policy whose bit is set, by keccak id.
  const bits = Buffer.from(root.bits.replace(/^0x/, ''), 'hex');
  const signers = new Set(root.policyKeys
    .filter((_, i) => (bits[i >> 3] >> (i & 7)) & 1)
    .map((k) => k.replace(/^0x/, '').toLowerCase()));
  const known = (await registrationsSoon()).filter((r) => signers.has(r.keyId.replace(/^0x/, '').toLowerCase()));
  const knows = await Promise.all(known.map((r) => knowsKey(near.rpc, route.vault, Buffer.from(r.raw).toString('hex'))));
  const learn = known.filter((_, i) => !knows[i]);
  const unknownSigners = [...signers].filter((id) => !known.some((r) => r.keyId.replace(/^0x/, '').toLowerCase() === id));
  const trusted = await isTrusted(near.rpc, route.vault, root.finality.finalityMroot);
  // The vault releases up to the deadline second and expires only after it.
  const pastDeadline = row.deadline !== null && row.deadline < Math.floor(Date.now() / 1000);

  return {
    code: 200,
    body: {
      key: row.key,
      direction: 'withdrawal',
      chain: near.chain.id,
      burnBlock: artifact.burnBlock,
      rootBlock: artifact.rootBlock,
      vault: artifact.vault,
      status: row.status,
      deadline: row.deadline,
      near: {
        network: near.chain.network,
        vault: route.vault,
        token: asset.tokenId,
        recipient,
        recipientAddress,
        signingGeneration: signing,
        seatedGeneration: vault.client.generation,
        catchUp: vault.client.generation < signing ? `/v1/handovers?after=${vault.client.generation}` : null,
        unknownSigners,
        rootTrusted: trusted,
        action: pastDeadline ? 'expire' : 'release',
        calls: nearSettleCalls({
          vault: route.vault, artifact, submitRoot: root, learn, trusted,
          token: asset.tokenId, recipient, pastDeadline,
        }),
      },
    },
  };
}

/** The cheapest root to fold a burn into: the oldest at or after it that the withdrawal's own chain trusts. */
function rootCovering(deps: Deps, row: TransferRow, burnBlock: number) {
  const target = chainOfDomain(deps.cfg, row.domain);
  return target?.kind === 'evm' ? deps.store.earliestRootCovering(burnBlock, target.chain.chainId) : undefined;
}

/**
 * Is the fast path on offer for this deposit, without building it?
 *
 * Confirmations and the route's limits answer it, and both are already here —
 * the EVM head from the follower, the route from a cached table read. Building
 * the bundle to find out would be several beacon requests per row per poll.
 */
async function fastReady(
  deps: Deps,
  row: TransferRow,
): Promise<{ ready: boolean; confirmations: number; reason: string }> {
  const source = chainOfDomain(deps.cfg, row.domain);
  const follower = followerOf(deps, row.domain);
  if (source?.kind !== 'evm' || !follower) {
    return {
      ready: false,
      confirmations: 0,
      reason: `domain ${row.domain} is not a source chain this instance follows`,
    };
  }
  const { chain } = source;
  const confirmations = Math.max(0, follower.state.head - row.src_block);
  const wait = proofWait(deps, row);

  if (!row.token || !row.amount) {
    return { ready: false, confirmations, reason: `waiting on finality: ${wait}` };
  }

  // The fast path proves the deposit's OWN block against a beacon chain, so it
  // exists only where the source chain has one. BSC and Polygon are final in
  // seconds through their own provers, and there is no fast path to offer.
  if (chain.strategy !== 'beacon') {
    const eta = depositEta(chain);
    const frontier = follower.state.provableUpTo;
    // Two halves, and a depositor can tell them apart only if we say which one
    // they are in: before the prover's frontier reaches their block there is
    // nothing to prove against; after it, only the push is left.
    const arrived = frontier >= 0 && row.src_block <= frontier;
    if (!arrived) {
      return { ready: false, confirmations, reason: `${eta.parts[0].what} — ${wait}` };
    }
    const left = eta.parts.slice(1).reduce((a, p) => a + p.seconds, 0);
    const next = eta.parts[1].what;
    return {
      ready: false,
      confirmations,
      reason: `the evidence is in; now ${next} — about ${humanEta(left)} more`,
    };
  }

  try {
    const fast = fastVerdict(await routeFor(deps.cfg, row.token, String(chain.chainId)), BigInt(row.amount), confirmations);
    if (!fast.offered) return { ready: false, confirmations, reason: `${fast.reason}; waiting for finality — ${wait}` };
    if (fast.left > 0) return { ready: false, confirmations, reason: confirmationsLeft(fast, chain.blockTime) };
    return { ready: true, confirmations, reason: '' };
  } catch (err) {
    return { ready: false, confirmations, reason: `route unknown: ${(err as Error).message}` };
  }
}

/** The far chain of a domain, by its registry id: `mainnet`, `wax`, `xpr`, `vaulta`; null for one this instance does not know. */
const chainOf = (deps: Deps, domain: string | null): string | null => chainOfDomain(deps.cfg, domain)?.chain.id ?? null;

/**
 * The follower watching a domain's chain.
 *
 * The row carries its domain, and that is what decides. This used to reach for a
 * single "own chain" follower instead, which subtracted one chain's height from
 * another chain's block number — an Amoy deposit measured against the Sepolia
 * head. That field is gone now so the shortcut cannot come back.
 */
function followerOf(deps: Deps, domain: string | null) {
  const source = chainOfDomain(deps.cfg, domain);
  return source?.kind === 'evm' ? deps.evms.find((f) => f.id === source.chain.id) : undefined;
}

/**
 * When a deposit's finalized proof stops fitting in one transaction; undefined
 * where there is no such clock.
 *
 * Only a beacon chain has one. Its finalized proof carries the `parent_root`
 * chain from the deposit's block up to a finalized header, one header a slot,
 * and the follower builds none longer than `maxAncestry` headers — it stops
 * queueing a deposit older than `maxAncestry * 12` seconds and refuses a longer
 * span when freezing (evm.ts, `freezeLog`). That is 13.65 hours at 4096, not the
 * sixteen this used to quote: sixteen is roughly where 600 KB runs out, and the
 * builder gives up before then. A Parlia or milestone proof is final in seconds
 * and carries no such chain; an Antelope deposit is its relayer's.
 */
function ancestryDeadline(cfg: IndexerConfig, row: TransferRow): number | undefined {
  const source = chainOfDomain(cfg, row.domain);
  if (source?.kind !== 'evm' || source.chain.strategy !== 'beacon') return undefined;
  return row.src_time + cfg.maxAncestry * SLOT_SECONDS;
}

/**
 * How long a log on the far side takes to become provable here, as a sentence.
 *
 * One helper for both directions because it is one question: a `Deposit` and a
 * `Voided` are the same log on the same chain proved by the same mechanism, and
 * the two callers had drifted into quoting the same wrong constant twice.
 */
function proofWait(deps: Deps, row: TransferRow): string {
  const source = chainOfDomain(deps.cfg, row.domain);
  const eta = source?.kind === 'evm'
    ? depositEta(source.chain)
    : source?.kind === 'sui'
      ? suiDepositEta(source.chain)
      : source?.kind === 'near'
        ? nearDepositEta(source.chain)
        : null;
  return eta?.human ?? 'a wait this chain has no measured figure for';
}

/**
 * Who a served proof names as its payer.
 *
 * `PROOF_PAYER` when the deployment set one, otherwise whoever the proof was built
 * for. The substitution happens here rather than at freezing time on purpose: a
 * stored artifact stays valid when the deployment changes its mind about which
 * account pays, and the payer is only ever an argument — nothing in the proof is
 * bound to it.
 */
function payerFor(deps: Deps, baked: string): string {
  return deps.cfg.proofPayer ?? baked;
}

/** Positional action arguments, payer first, with the payer `payerFor` names. */
const withPayer = (deps: Deps, args: unknown[]): unknown[] => [payerFor(deps, String(args[0])), ...args.slice(1)];

/** The two actions an Antelope-side proof always comes as, in argument order. */
function antelopeActions(
  deps: Deps,
  pr: any,
  gateway: any,
  gatewayAction: string,
  accounts: { lightClient: string; gateway: string },
): unknown[] {
  return [
    {
      account: accounts.lightClient,
      name: 'proveroot',
      data: [
        ...proverootPositional({ ...pr, payer: payerFor(deps, pr.payer) }),
      ],
    },
    {
      account: accounts.gateway,
      name: gatewayAction,
      // Two shapes, because two gateways take different arguments. Ethereum's
      // `credit` takes five and is stored as a named object; Polygon's
      // `creditcp` takes eight — the checkpoint and the Bor block ride along — and
      // is stored positionally, in the action's own order. An array is passed
      // through with only the payer substituted, so adding a gateway later
      // means adding arguments and nothing here.
      data: Array.isArray(gateway)
        ? withPayer(deps, gateway)
        : [payerFor(deps, gateway.payer), gateway.block_hash, gateway.key, gateway.nodes, gateway.log_index],
    },
  ];
}

/** The fast half of a deposit's proof: the proof and its track, or why there is none. */
type FastPart = { track?: 'fast'; fast?: Record<string, unknown>; fastUnavailable?: string };

/**
 * The fast proof, if the route allows one and the depth is there.
 *
 * Failure here is a normal answer, not an error: "eight of twelve confirmations"
 * is what a UI should show, and the finalized half is already in hand.
 */
async function fastPart(deps: Deps, row: TransferRow, gatewayAction: string): Promise<FastPart> {
  if (row.direction !== 'deposit' || !row.src_tx || !row.token || !row.amount) return {};

  const source = chainOfDomain(deps.cfg, row.domain);
  if (!source) return { fastUnavailable: `domain ${row.domain} is not a source chain this instance follows` };
  if (source.kind === 'antelope') {
    return { fastUnavailable: `${source.chain.name} deposits are proved by its relayer; there is no fast track to offer` };
  }
  // A fast proof is a beacon-chain idea: a committee-signed head plus a proved
  // confirmation depth. A Parlia route has no such thing to offer — its light
  // client accepts a vote only when it finalizes its source, so every proof it
  // takes is already final and the finalized track is the only one.
  if (source.chain.strategy !== 'beacon') {
    return { fastUnavailable: `${source.chain.id} finalizes in seconds; there is no fast track to offer` };
  }
  // And it is built live against the active chain's endpoints, so a beacon chain
  // this process is not configured for cannot be served one either.
  if (source.chain.id !== deps.cfg.evm.id) {
    return { fastUnavailable: `fast proofs for ${source.chain.id} are built by the instance that follows it` };
  }

  try {
    const fast = await buildFast(deps.cfg, {
      txHash: row.src_tx,
      blockNumber: row.src_block,
      topic0: TOPICS.deposit,
      amount: BigInt(row.amount),
      extToken: row.token,
      domain: String(source.chain.chainId),
    });
    return {
      track: 'fast',
      fast: {
        note:
          `${fast.confirmations} confirmations proved, ${fast.required} required — ` +
          `credited now instead of waiting for finality`,
        confirmations: fast.confirmations,
        required: fast.required,
        signedBy: fast.signedBy,
        actions: antelopeActions(deps, fast.proveroot, fast.credit, gatewayAction, source.accounts),
      },
    };
  } catch (err) {
    return { fastUnavailable: err instanceof FastUnavailable ? err.message : `could not be built: ${(err as Error).message}` };
  }
}

/**
 * What `/v1/swap/plan` reads from Telos, the Antelope chains and NEAR this
 * instance reads. Null when the chain is not one of them, or its node does not
 * answer.
 *
 * - An account exists when it has its `userres` row: every account the system
 *   contract created has one, on Telos, WAX, XPR and Vaulta alike, and a name
 *   nobody created has none. On NEAR, when `view_account` finds it.
 * - A token's precision is its `stat` row's supply; no row, no such token.
 */
function chainReader(cfg: IndexerConfig): ChainReader {
  const rpcOf = (chain: string) => {
    const antelope = cfg.antelope.find((a) => a.chain.id === chain);
    return chain === SETTLEMENT_CHAIN ? cfg.savanna : antelope ? { rpc: [antelope.rpc] } : null;
  };
  return {
    async account(chain, name) {
      const near = cfg.near.find((n) => n.chain.id === chain);
      if (near) {
        try {
          await nearRpc(near.rpc, 'query', { request_type: 'view_account', finality: 'final', account_id: name });
          return true;
        } catch (err) {
          return /UNKNOWN_ACCOUNT/.test((err as Error).message) ? false : null;
        }
      }
      const rpc = rpcOf(chain);
      if (!rpc) return null;
      try {
        const rows = await getTableRows(rpc, { code: 'eosio', scope: name, table: 'userres', limit: 1 });
        return rows.length > 0;
      } catch {
        return null;
      }
    },
    async precision(chain, contract, symbol) {
      const rpc = rpcOf(chain);
      if (!rpc) return null;
      try {
        const rows = await getTableRows<{ supply: string }>(rpc, { code: contract, scope: symbol, table: 'stat', limit: 1 });
        const supply = rows.find((row) => parseAsset(row.supply).symbol === symbol);
        return supply ? parseAsset(supply.supply).precision : false;
      } catch {
        return null;
      }
    },
  };
}

// --- plumbing --------------------------------------------------------------------------

/** `maxAge` only for public aggregates that are themselves shared for that long. */
function send(res: ServerResponse, code: number, body: unknown, maxAge?: number): void {
  const text = JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 1);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    // Everything else here answers "what is true right now", and the queue of
    // things waiting to be signed is the worst possible thing to serve from a
    // cache — a stale one shows work that is already done, or hides work that
    // is not.
    'cache-control': maxAge ? `public, max-age=${maxAge}` : 'no-store',
  });
  res.end(text);
}
