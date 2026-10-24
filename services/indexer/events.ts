/**
 * The bridge's events: each change to a transfer a person would see, numbered
 * and kept, so a page can be told of it and catch up on what it missed.
 *
 * The store names every transfer it writes (`Store.onChange`). Each is read
 * again as `/v1/activity/<key>` shows it and compared with the last reading of
 * it; a different reading is an event, and the new reading replaces the old in
 * the same transaction. A write that changed nothing a person sees — the
 * indexer re-reading a chain and writing the same row — makes none.
 *
 * What changed is said in one word, `change`, so a page can tell a toast from a
 * quiet update without comparing anything itself:
 *
 *   new            the first time the bridge has seen it
 *   action_needed  the next step became the user's: a release to sign
 *   delivered      at the recipient
 *   returned       given back, or on its way back
 *   progress       anything else: a stage, a transaction, back in the bridge's hands
 *
 * An empty log starts from every transfer as it stands, quietly, so the first
 * day of a new deployment is not a flood of `new` for old crossings. Kept for
 * thirty days; a page away longer starts from a fresh snapshot instead.
 */

import { activities, activityOf, type Activity, type ActivityContext, type ActivityState } from './activity.ts';
import type { EventRow, Store } from './db.ts';

export const CHANGES = ['new', 'progress', 'action_needed', 'delivered', 'returned'] as const;
export type Change = (typeof CHANGES)[number];

/** One event, as `/v1/stream` sends it and `/v1/events` lists it. */
export type TransferEvent = {
  /** Increasing; what `Last-Event-ID` and `after` name. */
  id: number;
  /** Unix seconds, when the indexer saw the change. */
  at: number;
  change: Change;
  /** The transfer as it is now, as `/v1/activity/<key>` shows it. */
  transfer: Activity;
  /** Where it stood before; null for `new`. */
  previous: { state: ActivityState; stage: string } | null;
};

/** Told each event, with the keys whose writes made it (a hop's leg, a refused deposit's way back). */
export type EventListener = (event: TransferEvent, written: string[]) => void;

/** How long events are kept. */
const KEEP_SECONDS = 30 * 86_400;
/** Writes this close together are read once: a block's worth of a replay is one pass. */
const BATCH_MS = 50;

export class EventLog {
  private readonly store: Store;
  private readonly context: () => ActivityContext;
  private readonly listeners = new Set<EventListener>();
  /** Keys written since the last pass. */
  private readonly pending = new Set<string>();
  private batch: NodeJS.Timeout | undefined;
  private prunedAt = 0;

  constructor(store: Store, context: () => ActivityContext) {
    this.store = store;
    this.context = context;
  }

  /** Start from where everything stands when the log is empty, then record each change. */
  start(): void {
    if (!this.store.hasReadings()) {
      this.store.putReadings(activities(this.store, this.context()).map((a) => [a.key, JSON.stringify(a)]));
    }
    this.store.onChange((key) => this.written(key));
    this.prune();
  }

  onEvent(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** As stored, for a page catching up or listing; see `Store.events`. */
  list(q: { keys?: string[]; parties?: string[]; after?: number; limit: number }): TransferEvent[] {
    return this.store.events(q).map(served);
  }

  private written(key: string): void {
    this.pending.add(key);
    this.batch ??= setTimeout(() => this.pass(), BATCH_MS);
  }

  private pass(): void {
    this.batch = undefined;
    const keys = [...this.pending];
    this.pending.clear();
    try {
      this.record(keys);
      this.prune();
    } catch (err) {
      // The keys are written again soon enough, and a reading left behind makes the event then.
      console.log(`[events] ${(err as Error).message}`);
    }
  }

  private record(keys: string[]): void {
    const ctx = this.context();
    // Several writes of one pass can be one transfer: a hop's deposit and its leg.
    const byTransfer = new Map<string, { a: Activity; written: string[] }>();
    for (const key of keys) {
      const a = activityOf(this.store, key, ctx);
      if (!a) continue;
      const seen = byTransfer.get(a.key);
      if (seen) seen.written.push(key);
      else byTransfer.set(a.key, { a, written: [key] });
    }
    for (const { a, written } of byTransfer.values()) {
      const reading = JSON.stringify(a);
      const before = this.store.reading(a.key);
      if (before === reading) continue;
      const was = before === undefined ? undefined : (JSON.parse(before) as Activity);
      const body = {
        change: changeOf(was, a),
        transfer: a,
        previous: was ? { state: was.state, stage: was.stage } : null,
      };
      const at = Math.floor(Date.now() / 1000);
      const id = this.store.appendEvent({
        key: a.key,
        at,
        change: body.change,
        sender: a.from.address?.toLowerCase() ?? null,
        recipient: a.to.recipient?.toLowerCase() ?? null,
        body: JSON.stringify(body),
      }, reading);
      const event: TransferEvent = { id, at, ...body };
      for (const listener of this.listeners) listener(event, written);
    }
  }

  /** Once an hour at most. */
  private prune(): void {
    const now = Math.floor(Date.now() / 1000);
    if (now - this.prunedAt < 3600) return;
    this.prunedAt = now;
    this.store.pruneEvents(now - KEEP_SECONDS);
  }
}

/** What changed, in one word. */
export function changeOf(was: Activity | undefined, now: Activity): Change {
  if (!was) return 'new';
  return now.state !== was.state && now.state !== 'in_progress' ? now.state : 'progress';
}

const served = (row: EventRow): TransferEvent => ({ id: row.id, at: row.at, ...JSON.parse(row.body) });
