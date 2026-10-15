/**
 * Beacon light-client API client.
 *
 * Everything the bridge needs from the consensus layer comes from four
 * endpoints; this wraps them so the relayer and the one-shot script agree on
 * what a "committee for period P" or "the fork at slot S" means.
 */
import { EPOCHS_PER_SYNC_COMMITTEE_PERIOD, SLOTS_PER_EPOCH } from '@lodestar/params';
import { fetchJson, HttpError } from '../net/fetchJson.ts';
import { BEACON_URLS } from '../config.ts';

export const SLOTS_PER_PERIOD = EPOCHS_PER_SYNC_COMMITTEE_PERIOD * SLOTS_PER_EPOCH;

/** The sync committee period a slot belongs to. */
export const periodOfSlot = (slot: number) => Math.floor(slot / SLOTS_PER_PERIOD);

export const SECONDS_PER_SLOT = 12;

/** The period signing at `unixSeconds`, from the chain's beacon genesis time. */
export const periodAt = (genesisTime: number, unixSeconds: number) =>
  periodOfSlot(Math.floor((unixSeconds - genesisTime) / SECONDS_PER_SLOT));

export type Fork = { previous_version: string; current_version: string; epoch: string };

/**
 * Every endpoint answered 404, so the resource is absent rather than unreachable.
 *
 * For a slot that means one of two things, and the caller decides which matters:
 * nobody proposed there, or no node keeps it any more.
 */
export class BeaconNotFound extends Error {
  constructor(path: string) {
    super(`nothing at ${path} on any beacon endpoint — empty slot, or no longer retained`);
    this.name = 'BeaconNotFound';
  }
}

/**
 * How far past a slot to look for the next proposed block.
 *
 * An epoch of empty slots means the chain is not producing, which is not a gap
 * to scan through but a condition to report.
 */
const MAX_EMPTY_SLOT_SCAN = SLOTS_PER_EPOCH;

/**
 * Responses that do not change on their own, cached across instances.
 *
 * A committee is fixed for its period (~27 h) and weighs 57 KB; the genesis
 * root never changes at all; the fork schedule changes only at a fork. Fetching
 * them per proof was most of the bridge's beacon traffic.
 */
/** Roughly two months of periods; each is ~50 KB of hex. */
const COMMITTEE_CACHE_SIZE = 64;
const committeeCache = new Map<number, { pubkeys: string[]; branch: string[]; update: any }>();
let genesisRootCache: string | null = null;
let forkScheduleCache: { at: number; forks: Fork[] } | null = null;
const FORK_SCHEDULE_TTL_MS = 6 * 60 * 60 * 1000;

export class BeaconClient {
  readonly url: string;

  constructor(url: string) {
    this.url = url;
  }

  /**
   * Try the configured hosts in turn, starting with this client's own.
   * A dead host should cost one failed request, not the whole operation.
   */
  private async get(path: string): Promise<any> {
    const hosts = [this.url, ...BEACON_URLS.filter((u) => u !== this.url)];
    let lastErr: unknown;
    // Nodes prune to different depths, so one 404 is not an answer; every host
    // agreeing on 404 is.
    let allNotFound = true;
    for (const host of hosts) {
      try {
        return await fetchJson(host + path);
      } catch (err) {
        lastErr = err;
        if (!(err instanceof HttpError && err.status === 404)) allNotFound = false;
      }
    }
    if (allNotFound) throw new BeaconNotFound(path);
    throw new Error(`all beacon endpoints failed for ${path}: ${(lastErr as Error)?.message}`);
  }

  async genesisValidatorsRoot(): Promise<string> {
    if (genesisRootCache) return genesisRootCache;
    genesisRootCache = (await this.get('/eth/v1/beacon/genesis')).data.genesis_validators_root;
    return genesisRootCache;
  }

  async forkSchedule(): Promise<Fork[]> {
    if (forkScheduleCache && Date.now() - forkScheduleCache.at < FORK_SCHEDULE_TTL_MS) {
      return forkScheduleCache.forks;
    }
    const forks = (await this.get('/eth/v1/config/fork_schedule')).data;
    forkScheduleCache = { at: Date.now(), forks };
    return forks;
  }

  /** The fork active at a slot — the one whose version goes into the domain. */
  async forkAtSlot(slot: number): Promise<Fork> {
    const epoch = Math.floor(slot / SLOTS_PER_EPOCH);
    const fork = (await this.forkSchedule())
      .filter((f) => Number(f.epoch) <= epoch)
      .sort((a, b) => Number(a.epoch) - Number(b.epoch))
      .at(-1);
    if (!fork) throw new Error(`no fork active at epoch ${epoch}`);
    return fork;
  }

  async finalityUpdate(): Promise<any> {
    return (await this.get('/eth/v1/beacon/light_client/finality_update')).data;
  }

  /**
   * The head the sync committee is signing right now — one slot behind the wall
   * clock, versus ~13 min for a finality update. Carries no finality branch: it
   * says 495-ish of 512 validators see this block as head, not that the chain
   * can no longer abandon it.
   */
  /**
   * A signed beacon block. Unlike the light-client endpoints this is served for
   * any slot the node retains, which is what makes an old deposit provable.
   */
  /**
   * A block header by slot, or null when that slot was empty.
   *
   * Far cheaper than fetching the block: this endpoint returns the five fields
   * of `BeaconBlockHeader` directly, which is all a `parent_root` chain needs.
   */
  async headerAtSlotOrNull(slot: number): Promise<any | null> {
    try {
      const r = await this.get(`/eth/v1/beacon/headers/${slot}`);
      return r?.data?.header?.message ?? null;
    } catch (e) {
      if (e instanceof BeaconNotFound) return null;
      throw e;
    }
  }

  async blockAtSlot(slot: number): Promise<any> {
    return this.get(`/eth/v2/beacon/blocks/${slot}`);
  }

  /** The block at `slot`, or null when no endpoint has one. */
  async blockAtSlotOrNull(slot: number): Promise<any | null> {
    try {
      return await this.blockAtSlot(slot);
    } catch (err) {
      if (err instanceof BeaconNotFound) return null;
      throw err;
    }
  }

  /**
   * The first block proposed after `slot`, with the slot it landed in.
   *
   * Slots get missed, and only the first block after a header attests to that
   * header: the committee signs the head as it stands, so a later block signs
   * whatever was proposed in between instead.
   */
  async blockAfterSlot(slot: number): Promise<{ slot: number; block: any }> {
    for (let s = slot + 1; s <= slot + MAX_EMPTY_SLOT_SCAN; s++) {
      const block = await this.blockAtSlotOrNull(s);
      if (block) return { slot: s, block };
    }
    throw new Error(`no block proposed in slots ${slot + 1}..${slot + MAX_EMPTY_SLOT_SCAN}`);
  }

  async optimisticUpdate(): Promise<any> {
    return (await this.get('/eth/v1/beacon/light_client/optimistic_update')).data;
  }

  /**
   * The sync committee for `period`, i.e. the `next_sync_committee` published in
   * the update for the period before it, together with the branch that proves it
   * against that update's attested state.
   */
  async committeeForPeriod(period: number): Promise<{ pubkeys: string[]; branch: string[]; update: any }> {
    const hit = committeeCache.get(period);
    if (hit) return hit;

    const updates = await this.get(`/eth/v1/beacon/light_client/updates?start_period=${period - 1}&count=1`);
    const update = updates[0]?.data ?? updates[0];
    if (!update?.next_sync_committee) throw new Error(`no committee update for period ${period - 1}`);
    const result = {
      pubkeys: update.next_sync_committee.pubkeys,
      branch: update.next_sync_committee_branch,
      update,
    };
    committeeCache.set(period, result);
    // A proof no longer expires, so any period can be asked for — a window
    // around the head is the wrong shape. Keep the last N fetched instead;
    // Map iterates in insertion order, so the front entry is the one to drop.
    while (committeeCache.size > COMMITTEE_CACHE_SIZE) {
      committeeCache.delete(committeeCache.keys().next().value as number);
    }
    return result;
  }
}
