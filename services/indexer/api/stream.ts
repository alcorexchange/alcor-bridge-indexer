/**
 * `/v1/stream` and `/v1/events`: the bridge's events (events.ts), held open over
 * server-sent events or listed.
 *
 * A page needs two handlers and no bookkeeping:
 *
 *   snapshot   the transfers it asked for as they stand: replace the list
 *   transfer   one event: put `transfer` in the list by its key
 *
 * A stream opens with a snapshot. A browser that loses it reconnects by itself
 * and says the last event it had (`Last-Event-ID`); the events since are sent
 * again, in order, and the page never knows. Away too long (past what is kept,
 * or more than a page's worth), it gets a fresh snapshot instead — the same
 * handler. Either way it ends up exactly where everyone else is.
 *
 * Nothing here is faster than the indexer: a deposit shows up when its chain is
 * scanned, as it does on a poll. What goes is the poll's delay on top.
 */

import type { ServerResponse } from 'node:http';

import { activities, activityOf, newestFirst, type Activity } from '../activity.ts';
import type { EventLog, TransferEvent } from '../events.ts';
import { activityContext } from './context.ts';
import type { Deps } from './deps.ts';
import { BadRequest, exact, fail, intParam, json, type Reply, type Request, type Route } from './http.ts';

/** Streams one address may hold open: a few tabs, not a scraper. */
const PER_IP = 10;
/** Streams this process holds open at most. */
const IN_ALL = 2000;
/** Keys one stream may follow. */
const KEYS = 50;
/** Parties one stream may follow: a person's wallets on several chains. */
const PARTIES = 10;
/** Transfers in a snapshot of parties or of everything: the newest. */
const SNAPSHOT = 50;
/** Missed events sent again after a reconnect; past this a snapshot says it in one message. */
const REPLAY = 500;
/** A comment line this often keeps a proxy from closing an idle stream (Cloudflare's limit is 100 s). */
const PING_MS = 20_000;
/** A stream that stopped reading is dropped once this much waits for it. */
const BACKLOG_BYTES = 1 << 20;

/** What a stream or a listing asks for. Neither keys nor parties: everything. */
type Filter = {
  /** The keys asked for, and each transfer's own key once one of them is seen. */
  keys: Set<string> | null;
  /** Addresses or accounts, any of them at either end, lowercased. */
  parties: Set<string> | null;
};

type Stream = Filter & { res: ServerResponse; ip: string };

class Hub {
  private readonly deps: Deps;
  private readonly streams = new Set<Stream>();
  private ping: NodeJS.Timeout | undefined;

  constructor(deps: Deps) {
    this.deps = deps;
    deps.events.onEvent((event, written) => {
      for (const s of this.streams) if (wants(s, event, written)) this.event(s, event);
    });
  }

  /** How many streams `ip` holds, and how many there are. */
  count(ip: string): { mine: number; all: number } {
    let mine = 0;
    for (const s of this.streams) if (s.ip === ip) mine++;
    return { mine, all: this.streams.size };
  }

  open(res: ServerResponse, stream: Omit<Stream, 'res'>, lastEventId: number | undefined): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // nginx would hold the events back to fill a buffer; this tells it not to.
      'x-accel-buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    const s: Stream = { res, ...stream };
    resolve(this.deps, s);

    // Synchronous from here to `add`: no event can be recorded between what is
    // read for this stream and its joining, so nothing falls in the gap.
    const missed = lastEventId === undefined ? undefined : this.missed(s, lastEventId);
    if (missed) for (const event of missed) this.event(s, event);
    else this.snapshot(s);
    this.streams.add(s);

    res.on('close', () => this.close(s));
    this.ping ??= setInterval(() => {
      for (const t of this.streams) this.send(t, ': ping\n\n');
    }, PING_MS).unref();
  }


  /** The events after `lastEventId` this stream asked for; undefined when a snapshot says it better. */
  private missed(s: Stream, lastEventId: number): TransferEvent[] | undefined {
    const oldest = this.deps.store.oldestEventId();
    // Events between the one it had and the oldest kept are gone: only a snapshot is whole.
    if (oldest !== undefined && lastEventId < oldest - 1) return undefined;
    if (lastEventId > this.deps.store.lastEventId()) return undefined;
    const events = this.deps.events.list({ ...asQuery(s), after: lastEventId, limit: REPLAY + 1 });
    return events.length > REPLAY ? undefined : events;
  }

  private snapshot(s: Stream): void {
    const transfers = snapshotOf(this.deps, s);
    const id = this.deps.store.lastEventId();
    this.send(s, `id: ${id}\nevent: snapshot\ndata: ${JSON.stringify({ transfers, lastEventId: id })}\n\n`);
  }

  private event(s: Stream, event: TransferEvent): void {
    this.send(s, `id: ${event.id}\nevent: transfer\ndata: ${JSON.stringify(event)}\n\n`);
  }

  private send(s: Stream, text: string): void {
    if (s.res.writableLength > BACKLOG_BYTES) return void s.res.destroy();
    s.res.write(text);
  }

  private close(s: Stream): void {
    this.streams.delete(s);
    if (this.streams.size > 0) return;
    clearInterval(this.ping);
    this.ping = undefined;
  }
}

/** Each key asked for, joined by the key of the transfer it belongs to, where that is known yet. */
function resolve(deps: Deps, f: Filter): void {
  const ctx = activityContext(deps);
  for (const key of [...(f.keys ?? [])]) {
    const a = activityOf(deps.store, key, ctx);
    if (a) f.keys!.add(a.key);
  }
}

/** Whether a stream asked for this transfer; a key it asked for marks the transfer's own key as asked too. */
function wants(s: Filter, event: TransferEvent, written: string[]): boolean {
  const t = event.transfer;
  if (!s.keys && !s.parties) return true;
  if (s.keys && (s.keys.has(t.key) || written.some((k) => s.keys!.has(k)))) {
    s.keys.add(t.key);
    return true;
  }
  return s.parties !== null && ofParties(t, s.parties);
}

/** The transfers a filter names, as they stand: the keys', and the parties' or everyone's newest. */
function snapshotOf(deps: Deps, f: Filter): Activity[] {
  const ctx = activityContext(deps);
  const found = new Map<string, Activity>();
  for (const key of f.keys ?? []) {
    const a = activityOf(deps.store, key, ctx);
    if (a) found.set(a.key, a);
  }
  if (f.keys && !f.parties) return [...found.values()].sort(newestFirst);
  const newest = activities(deps.store, ctx).filter((a) => !found.has(a.key) && (!f.parties || ofParties(a, f.parties)));
  return [...found.values(), ...newest].sort(newestFirst).slice(0, Math.max(SNAPSHOT, found.size));
}

const ofParties = (a: Activity, parties: Set<string>) =>
  parties.has(a.from.address?.toLowerCase() ?? '') || parties.has(a.to.recipient?.toLowerCase() ?? '');

const asQuery = (f: Filter) => ({ keys: f.keys ? [...f.keys] : undefined, parties: f.parties ? [...f.parties] : undefined });

/** `key` and `party`, each repeatable, from a query; a rollback `v:7` is told as its withdrawal `w:7`. */
function filterOf(q: URLSearchParams): Filter {
  const asked = q.getAll('key').filter(Boolean);
  if (asked.length > KEYS) throw new BadRequest(`no more than ${KEYS} keys at once`);
  const parties = q.getAll('party').map((p) => p.trim().toLowerCase()).filter(Boolean);
  if (parties.length > PARTIES) throw new BadRequest(`no more than ${PARTIES} parties at once`);
  return {
    keys: asked.length ? new Set(asked.flatMap((k) => (k.startsWith('v:') ? [k, `w:${k.slice(2)}`] : [k]))) : null,
    parties: parties.length ? new Set(parties) : null,
  };
}

/** The id a reconnecting stream had: the browser's header, or `after` for a client that reconnects by hand. */
function lastEventIdOf({ q, header }: Request): number | undefined {
  const raw = header('last-event-id') ?? q.get('after') ?? undefined;
  if (raw === undefined || raw === '') return undefined;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id >= 0 ? id : undefined;
}

/** One hub per event log: every stream on it shares the one listener. */
const hubs = new WeakMap<EventLog, Hub>();
const hubOf = (deps: Deps): Hub => {
  let hub = hubs.get(deps.events);
  if (!hub) hubs.set(deps.events, (hub = new Hub(deps)));
  return hub;
};

export const streamRoutes: Route[] = [
  {
    shown: '/v1/stream',
    match: exact('/v1/stream'),
    handle: (req): Reply => {
      const filter = filterOf(req.q);
      const hub = hubOf(req.deps);
      const { mine, all } = hub.count(req.ip);
      if (mine >= PER_IP) return fail(429, 'RATE_LIMITED', `no more than ${PER_IP} streams open from one address`);
      if (all >= IN_ALL) return fail(429, 'RATE_LIMITED', 'this instance holds as many streams as it takes; try again shortly');
      const lastEventId = lastEventIdOf(req);
      return { open: (res) => hub.open(res, { ...filter, ip: req.ip }, lastEventId) };
    },
  },
  {
    shown: '/v1/events',
    match: exact('/v1/events'),
    handle: ({ deps, q }): Reply => {
      const filter = filterOf(q);
      resolve(deps, filter);
      const after = intParam(q, 'after', 0, Number.MAX_SAFE_INTEGER);
      const limit = intParam(q, 'limit', 1, 100) ?? 10;
      const events = deps.events.list({ ...asQuery(filter), after, limit });
      return json(200, { events, last: events.at(-1)?.id ?? after ?? deps.store.lastEventId() });
    },
  },
];
