/** `/v1/hops`: journeys through the hop contract, each keyed by the deposit that started it. */

import { withdrawalKey, type HopRow } from '../db.ts';
import { journey, journeyOf as journeyKeyOf } from '../hops.ts';
import { progressContext } from './context.ts';
import { chainOf, type Deps } from './deps.ts';
import { exact, fail, intParam, json, pattern, type Route } from './http.ts';
import { decorate } from './transfers.ts';

export const hopRoutes: Route[] = [
  {
    shown: '/v1/hops',
    match: exact('/v1/hops'),
    handle: ({ deps, q }) => {
      if (q.get('recover') === 'true') {
        const waiting = deps.store.awaitingRecover().map((h) => ({ hop: h, key: journeyKeyOf(deps.store, h) }));
        const keys = [...new Set(waiting.map((w) => w.key).filter((k) => k !== null))];
        const hops = [
          ...keys.map((k) => journeyOf(deps, k)).filter((j) => j !== undefined),
          ...waiting.filter((w) => w.key === null).map((w) => unkeyedHop(deps, w.hop)),
        ];
        return json(200, { hops, count: hops.length });
      }
      const keys = !deps.cfg.savanna.accounts.hop ? [] : deps.store.hopDeposits({
        hop: deps.cfg.savanna.accounts.hop,
        party: q.get('party') ?? undefined,
        before: intParam(q, 'before', 0, Number.MAX_SAFE_INTEGER),
        limit: intParam(q, 'limit', 1, 500),
      });
      const hops = keys.map((k) => journeyOf(deps, k)).filter((j) => j !== undefined);
      return json(200, { hops, count: hops.length });
    },
  },
  {
    shown: '/v1/hops/<key>',
    match: pattern(/^\/v1\/hops\/(.+)$/),
    handle: ({ deps, params: [key] }) => {
      const found = journeyOf(deps, key);
      if (!found) return fail(404, 'NOT_FOUND', 'no such deposit');
      return json(200, found);
    },
  },
];

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
