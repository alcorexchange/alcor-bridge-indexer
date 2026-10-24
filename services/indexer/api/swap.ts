/** `/v1/swap/quote` and `/v1/swap/plan`: a swap on one chain, and a crossing with swaps in it. */

import { nearRpc } from '../../../src/near/rpc.ts';
import { getTableRows } from '../../../src/net/antelope.ts';
import { parseAsset } from '../../../src/units.ts';
import { SETTLEMENT_CHAIN, type IndexerConfig } from '../config.ts';
import { alcorQuote, PlanRefused, swapPlan, type ChainReader, type PlanChain, type PlanRoute } from '../plan.ts';
import { evmSwapQuote, QuoteRefused } from '../quote.ts';
import { routes, status } from './cache.ts';
import { exact, fail, json, type Route } from './http.ts';

export const swapRoutes: Route[] = [
  {
    shown: '/v1/swap/quote?chain=&tokenIn=&tokenOut=&amountIn=[&slippageBps=50]',
    match: exact('/v1/swap/quote'),
    handle: async ({ deps, q }) => {
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
        return json(200, quote);
      } catch (err) {
        return err instanceof QuoteRefused
          ? fail(400, 'INVALID_REQUEST', err.message)
          : fail(502, 'UPSTREAM_ERROR', (err as Error).message);
      }
    },
  },
  {
    shown: '/v1/swap/plan?from=&to=&amount=&recipient=&sender=[&slippageBps=50][&deadlineSeconds=1800][&courierFee=]',
    match: exact('/v1/swap/plan'),
    handle: async ({ deps, q }) => {
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
          courierFee: q.get('courierFee') ?? undefined,
        }, {
          routes: all as PlanRoute[],
          chains: current.sources as PlanChain[],
          settlement: { bridge: deps.cfg.savanna.accounts.bridge, hop: deps.cfg.savanna.accounts.hop ?? null },
          quote: alcorQuote,
          read: chainReader(deps.cfg),
          now: Math.floor(Date.now() / 1000),
        });
        return json(200, plan);
      } catch (err) {
        return err instanceof PlanRefused
          ? fail(400, 'INVALID_REQUEST', err.message)
          : fail(502, 'UPSTREAM_ERROR', (err as Error).message);
      }
    },
  },
];

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
