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
 *
 * This file is the server and the route table; each route lives with the
 * resource it serves.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { warmListings } from '../fast.ts';
import { activityRoutes } from './activity.ts';
import { status } from './cache.ts';
import { chainRoutes } from './chains.ts';
import type { Deps } from './deps.ts';
import { docRoutes } from './docs.ts';
import { handoverRoutes } from './handovers.ts';
import { healthRoutes } from './health.ts';
import { hopRoutes } from './hops.ts';
import { BadRequest, fail, json, pattern, send, type Reply, type Route } from './http.ts';
import { pendingRoutes } from './pending.ts';
import { proofRoutes } from './proofs.ts';
import { streamRoutes } from './stream.ts';
import { swapRoutes } from './swap.ts';
import { transferRoutes } from './transfers.ts';

export type { Deps } from './deps.ts';

export const ROUTES: Route[] = [
  ...healthRoutes,
  ...docRoutes,
  ...activityRoutes,
  ...streamRoutes,
  ...chainRoutes,
  ...handoverRoutes,
  ...swapRoutes,
  ...hopRoutes,
  ...pendingRoutes,
  ...transferRoutes,
  ...proofRoutes,
];

/** A legacy chain's blockroot keeper (`/v1/wax`, `/v1/xpr`), and the merkle as it stood at any block it holds. */
const keeperPath = pattern(/^\/v1\/([a-z]+)(?:\/blockroot\/(\d+))?$/);

export function createApi(deps: Deps) {
  const server = createServer((req, res) => {
    handle(deps, req, res).catch((err) => {
      send(res, err instanceof BadRequest
        ? fail(400, 'INVALID_REQUEST', err.message)
        : fail(500, 'INTERNAL_ERROR', (err as Error).message));
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
  // A browser asks first when a request carries a header of its own.
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-methods': 'GET, OPTIONS',
      'access-control-allow-headers': '*',
      'access-control-max-age': '86400',
    });
    return void res.end();
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('allow', 'GET, HEAD, OPTIONS');
    return send(res, fail(405, 'METHOD_NOT_ALLOWED', `${req.method} is not served: this API only reads`));
  }

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
  if (base && raw === '/') return send(res, index(deps, base));
  if (base && !(raw === base || raw.startsWith(`${base}/`))) {
    return send(res, fail(404, 'NOT_FOUND', `no route for ${raw}; this instance serves under ${base}`));
  }
  const path = base ? raw.slice(base.length) || '/' : raw;

  for (const route of ROUTES) {
    const params = route.match(path);
    if (params) return send(res, await route.handle({ deps, q, params, ip: clientIp(req), header: (name) => headerOf(req, name) }));
  }

  const kept = keeperPath(path);
  const keeper = kept ? deps.keepers.get(kept[0]) : undefined;
  if (kept && keeper) return send(res, keeperState(keeper, kept[1]));

  send(res, fail(404, 'NOT_FOUND', `no route for ${raw}`));
}

/**
 * Who asks: Cloudflare's header, then nginx's, then the socket. The API listens
 * on loopback behind the proxy (README), so the headers are the proxy's own.
 */
function clientIp(req: IncomingMessage): string {
  return headerOf(req, 'cf-connecting-ip') ?? headerOf(req, 'x-real-ip') ?? req.socket.remoteAddress ?? 'unknown';
}

/** A request header, the first if repeated; undefined when absent or blank. */
function headerOf(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return (Array.isArray(v) ? v[0] : v)?.trim() || undefined;
}

/** What a keeper holds now, or as it stood at `block`. */
function keeperState(keeper: NonNullable<ReturnType<Deps['keepers']['get']>>, block: string): Reply {
  if (block === '') return json(200, keeper.snapshot());
  try {
    return json(200, keeper.stateAt(Number(block)));
  } catch (err) {
    return fail(404, 'NOT_FOUND', (err as Error).message);
  }
}

/** The bare root under a prefix: where everything is. */
function index(deps: Deps, base: string): Reply {
  return json(200, {
    instance: deps.cfg.instance,
    api: `${base}/health`,
    docs: `${base}/docs`,
    botDocs: `${base}/docs/bot`,
    routes: [
      ...ROUTES.map((r) => `${base}${r.shown}`),
      ...[...deps.keepers.keys()].flatMap((id) => [`${base}/v1/${id}`, `${base}/v1/${id}/blockroot/<block>`]),
    ],
  });
}
