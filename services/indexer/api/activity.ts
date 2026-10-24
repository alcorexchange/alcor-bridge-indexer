/** The public bridge page: the activity feed, its summaries, the reserves and the volume. */

import { PERIODS, STATES, activityOf, feed, type ActivityState, type Period } from '../activity.ts';
import { assetFor } from '../fast.ts';
import { complete } from '../reserves.ts';
import { volume } from '../volume.ts';
import { activitySoon, reservesSoon, summarySoon } from './cache.ts';
import { activityContext } from './context.ts';
import { chainOf } from './deps.ts';
import { exact, fail, intParam, json, pattern, type Route } from './http.ts';

export const activityRoutes: Route[] = [
  {
    shown: '/v1/volume', operator: true,
    match: exact('/v1/volume'),
    handle: ({ deps, q }) => {
      const days = intParam(q, 'days', 1, 366) ?? 30;
      return json(200, volume(deps.store, (domain, token) => {
        const listed = assetFor(token, domain);
        return { chain: chainOf(deps, domain), symbol: listed?.symbol ?? null, precision: listed?.precision ?? null };
      }, Math.floor(Date.now() / 1000), days));
    },
  },
  {
    shown: '/v1/activity',
    match: exact('/v1/activity'),
    handle: async ({ deps, q }) => {
      const limit = intParam(q, 'limit', 1, 100) ?? 25;
      const state = q.get('state');
      if (state && !(STATES as readonly string[]).includes(state)) {
        return fail(400, 'INVALID_REQUEST', `state is one of ${STATES.join(', ')}`);
      }
      const filter = {
        chain: q.get('chain') ?? undefined,
        asset: q.get('asset') ?? undefined,
        state: (state as ActivityState | null) ?? undefined,
        party: q.get('party') ?? undefined,
      };
      try {
        return json(200, feed(await activitySoon(deps), filter, limit, q.get('cursor') ?? undefined), 15);
      } catch (err) {
        return fail(400, 'INVALID_REQUEST', (err as Error).message);
      }
    },
  },
  {
    // Before `<key>`, which would otherwise take `summary` for a key.
    shown: '/v1/activity/summary',
    match: exact('/v1/activity/summary'),
    handle: async ({ deps, q }) => {
      const period = q.get('period') ?? 'all';
      if (!Object.hasOwn(PERIODS, period)) {
        return fail(400, 'INVALID_REQUEST', `period is one of ${Object.keys(PERIODS).join(', ')}`);
      }
      return json(200, await summarySoon(deps, period as Period), 30);
    },
  },
  {
    // Read now rather than from the shared feed: a page following one transfer wants its latest state.
    shown: '/v1/activity/<key>',
    match: pattern(/^\/v1\/activity\/(.+)$/),
    handle: ({ deps, params: [key] }) => {
      const found = activityOf(deps.store, key, activityContext(deps));
      return found ? json(200, found) : fail(404, 'NOT_FOUND', 'no such transfer');
    },
  },
  {
    shown: '/v1/reserves',
    match: exact('/v1/reserves'),
    handle: async ({ deps }) => {
      const out = await reservesSoon(deps);
      // A partial answer is not for a cache to hold: the next request may well read everything.
      return json(200, out, complete(out.assets) ? 60 : undefined);
    },
  },
];
