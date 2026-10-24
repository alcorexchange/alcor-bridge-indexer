/**
 * The chains and what keeps them running: their status and routes, the keys and
 * upkeep their light clients need, the Telos finality tree, and each legacy
 * chain's blockroot keeper.
 */

import { treeThrough } from '../../../src/savanna/rebranch.ts';
import { finalizerKeys } from '../finalizerKeys.ts';
import { upkeep } from '../upkeep.ts';
import { routes, status } from './cache.ts';
import { exact, fail, json, pattern, type Route } from './http.ts';

export const chainRoutes: Route[] = [
  { shown: '/v1/chains', match: exact('/v1/chains'), handle: async ({ deps }) => json(200, await status(deps)) },
  {
    shown: '/v1/routes',
    match: exact('/v1/routes'),
    handle: async ({ deps, q }) => {
      const all = (await routes(deps)) as { symbol: string; from: string; to: string }[];
      const symbol = q.get('symbol');
      const from = q.get('from');
      const to = q.get('to');
      const picked = all.filter((r) => (!symbol || r.symbol === symbol) && (!from || r.from === from) && (!to || r.to === to));
      return json(200, { routes: picked, count: picked.length });
    },
  },
  {
    shown: '/v1/finalizer-keys', operator: true,
    match: exact('/v1/finalizer-keys'),
    handle: async ({ deps, q }) => {
      const keys = await finalizerKeys(deps.cfg);
      const chain = q.get('chain');
      return json(200, chain ? { ...keys, chains: keys.chains.filter((c) => c.chain === chain) } : keys);
    },
  },
  {
    shown: '/v1/upkeep', operator: true,
    match: exact('/v1/upkeep'),
    handle: async ({ deps, q }) => {
      const u = await upkeep(deps.cfg, deps.store);
      const chain = q.get('chain');
      return json(200, chain
        ? { ...u, todo: u.todo.filter((t) => t.chain === chain), chains: u.chains.filter((c) => c.chain === chain) }
        : u);
    },
  },
  {
    // A finality-tree branch for any block still in the leaf window: the root as of
    // that block and the path to its leaf. A Telos -> Antelope relayer folds a withdrawal
    // into the root a proved header carries, and checks the root itself.
    shown: '/v1/savanna/branch/<block>', operator: true,
    match: pattern(/^\/v1\/savanna\/branch\/(\d+)$/),
    handle: ({ deps, params: [raw] }) => {
      const block = Number(raw);
      try {
        const local = treeThrough(deps.cfg.checkpointDir, deps.savanna.leafStore, block, block);
        const leaf = deps.savanna.leafStore.read(block)!;
        const steps = local.tree.proof(leaf, local.root);
        return json(200, { block, root: local.root, leaf: Buffer.from(leaf).toString('hex'), steps });
      } catch (err) {
        return fail(404, 'NOT_FOUND', (err as Error).message);
      }
    },
  },
];
