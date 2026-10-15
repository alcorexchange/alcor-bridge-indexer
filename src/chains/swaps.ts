/**
 * What a cross-chain swap needs on each chain: one signature where it starts,
 * the token the user wants where it ends.
 *
 * - On an Antelope chain: `bridgeroute`. A crossing pays out to it with a memo
 *   naming where the token bought goes, the token and the least of it, a
 *   deadline, and where what arrived goes back to; the executor service swaps
 *   it on Alcor's venues there. On Telos, where the ledger is, either place may be on
 *   another chain: the swap happens in the middle of a journey, and bridgehop
 *   carries the result on.
 * - At the start, on an EVM chain: `AlcorRouter`. One transaction swaps the
 *   user's token through an aggregator into one the vault takes and deposits it.
 *   The calldata comes from the aggregator's
 *   API, quoted by `/v1/swap/quote`.
 *
 * A contract that is not deployed yet has no address here, and then nothing
 * offers that leg: `/v1/chains` names only what is live.
 */

/** A venue `bridgeroute` sends an order's tokens to: swap.alcor, or an orderbook. */
export type Venue = { account: string; kind: 'amm' | 'book' };

export type AntelopeSwaps = {
  /** bridgeroute's account; absent until it is deployed on this chain. */
  route?: string;
  /** Alcor on this chain: `/api/v3/swapRouter/getRoute` is where the executor gets its legs. */
  alcorApi: string;
  /** What `setvenue` lists, and so the only accounts a leg may go to. */
  venues: Venue[];
};

/**
 * The memo `bridgeroute` reads, as the front end writes it. `to` and `back` are
 * each an account on the chain the order is on, or — on Telos only — a leg,
 * `<domain>:<recipient>`, on a chain the bridge reaches from there. `back` left
 * out is `to`.
 */
export const ROUTE_MEMO = {
  format: '<to>|<least out>@<token contract>|<deadline>[|<back>]',
  example: 'alice|403.5737 TLM@alien.worlds|1760300000',
  /** Polygon USDC swapped on Telos, delivered on BSC as USDT; back to Polygon if it never swaps. */
  exampleOnward: '56:0x5b38da6a701c568545dcfcb03fcb875f56beddc4|99.500000 USDT@wrap.alcor|1760300000|137:0x5b38da6a701c568545dcfcb03fcb875f56beddc4',
  /** An Antelope transfer's memo limit, which the whole deposit memo — hop legs and all — has to fit. */
  maxBytes: 256,
  /** The furthest a deadline may be set, in seconds: one further is a memo not understood. */
  maxWait: 7 * 24 * 3600,
} as const;

/**
 * The venues each chain's Alcor router was seen sending legs to, 2026-10-12.
 * route.alcor deployed on all four 2026-10-12, build a55047b5…
 */
export const ANTELOPE_SWAPS: Record<string, AntelopeSwaps> = {
  telos: {
    route: 'route.alcor',
    alcorApi: 'https://telos.alcor.exchange',
    venues: [{ account: 'swap.alcor', kind: 'amm' }],
  },
  wax: {
    route: 'route.alcor',
    alcorApi: 'https://wax.alcor.exchange',
    venues: [
      { account: 'swap.alcor', kind: 'amm' },
      { account: 'alcordexmain', kind: 'book' },
    ],
  },
  xpr: {
    route: 'route.alcor',
    alcorApi: 'https://proton.alcor.exchange',
    venues: [{ account: 'swap.alcor', kind: 'amm' }],
  },
  vaulta: {
    route: 'route.alcor',
    alcorApi: 'https://eos.alcor.exchange',
    venues: [
      { account: 'swap.alcor', kind: 'amm' },
      { account: 'eostokensdex', kind: 'book' },
    ],
  },
};

/** Uniswap's Permit2: one address on every EVM chain. AlcorRouter takes ERC-20s through it. */
export const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';

export type EvmSwaps = {
  /** AlcorRouter; absent until it is deployed on this chain. */
  router?: string;
  /** KyberSwap's name for the chain in its API path. */
  kyberChain: string;
};

/** Keyed by the EVM registry's id (src/chains/evm.ts). */
export const EVM_SWAPS: Record<string, EvmSwaps> = {
  mainnet: { kyberChain: 'ethereum' },
  bsc: { kyberChain: 'bsc' },
  polygon: { kyberChain: 'polygon' },
};

/** KyberSwap's aggregator: free, keyless, the same router contract on every chain it serves. */
export const KYBER = {
  api: 'https://aggregator-api.kyberswap.com',
  router: '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5',
  /** How the API names a chain's native coin; AlcorRouter and the vaults name it the zero address. */
  native: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
} as const;

/** The hop memo bridgehop reads, which a swap at the far end rides in as its third part. */
export const HOP_MEMO = {
  format: '<domain>:<recipient>|<domain>:<recipient>[|<memo>]',
  example: '1181148696416462999:route.alcor|1:0x…|alice|403.5737 TLM@alien.worlds|1760300000',
  maxBytes: 256,
} as const;

/** What `/v1/chains` says about swaps ending on an Antelope chain: null where bridgeroute is not deployed. */
export function antelopeSwapsView(id: string) {
  const s = ANTELOPE_SWAPS[id];
  if (!s?.route) return null;
  return { route: s.route, memo: ROUTE_MEMO, venues: s.venues, alcorApi: s.alcorApi };
}

/** What `/v1/chains` says about swaps starting on an EVM chain: null where AlcorRouter is not deployed. */
export function evmSwapsView(id: string) {
  const s = EVM_SWAPS[id];
  if (!s?.router) return null;
  return {
    router: s.router,
    permit2: PERMIT2,
    swappers: [{ name: 'kyberswap', address: KYBER.router }],
    /** The calldata for `swapAndDeposit`, ready to send. */
    quote: '/v1/swap/quote',
  };
}
