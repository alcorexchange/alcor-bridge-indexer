/**
 * `/v1/swap/quote`: the arguments for AlcorRouter's one-transaction swap and
 * deposit, from an aggregator's quote.
 *
 * The front end has a token the vault does not take and a crossing to make.
 * This asks KyberSwap for the route with AlcorRouter as both its caller and its
 * recipient — the router measures what comes back, so the output must land
 * there — and returns the `Swap` half of the call, ready to send. The other
 * half, the deposit (`telosTo`, the fill terms, the memo), is the same as for a
 * plain deposit and stays the front end's.
 *
 * `minOut` is the quote less the slippage asked for, in raw units of the token
 * out; the router reverts below it, so a price that moves too far costs a
 * reverted transaction and nothing else.
 */

import { EVM_SWAPS, KYBER, PERMIT2 } from '../../src/chains/swaps.ts';
import { fetchJson } from '../../src/net/fetchJson.ts';

/** A request the front end got wrong, as opposed to an aggregator that failed: answered 400. */
export class QuoteRefused extends Error {}

export type QuoteRequest = {
  /** The EVM registry's id: `mainnet`, `bsc`, `polygon`. */
  chain: string;
  /** The user's token; the zero address for the native coin. */
  tokenIn: string;
  /** A token this chain's vault takes; the zero address for the native coin. */
  tokenOut: string;
  /** Raw units of `tokenIn`. */
  amountIn: string;
  /** In basis points: 50 is half a percent. */
  slippageBps: number;
};

const ZERO = '0x0000000000000000000000000000000000000000';
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
/** KyberSwap names the native coin by a placeholder address; the vaults and the router by zero. */
const kyberToken = (address: string) => (same(address, ZERO) ? KYBER.native : address);

/**
 * The swap for `r`, given the tokens this chain's vault takes (`/v1/chains`'
 * routes, `token` each, zero for the native coin).
 */
export async function evmSwapQuote(r: QuoteRequest, vaultTokens: string[]) {
  const swaps = EVM_SWAPS[r.chain];
  if (!swaps) throw new QuoteRefused(`chain is one of ${Object.keys(EVM_SWAPS).join(', ')}`);
  if (!swaps.router) throw new QuoteRefused(`AlcorRouter is not deployed on ${r.chain}`);
  if (!ADDRESS.test(r.tokenIn) || !ADDRESS.test(r.tokenOut)) throw new QuoteRefused('tokenIn and tokenOut are 0x addresses');
  if (!/^[1-9]\d{0,77}$/.test(r.amountIn)) throw new QuoteRefused('amountIn is a positive integer, in raw units');
  if (!Number.isInteger(r.slippageBps) || r.slippageBps < 1 || r.slippageBps > 1000) {
    throw new QuoteRefused('slippageBps is 1 to 1000');
  }
  if (!vaultTokens.some((t) => same(t, r.tokenOut))) throw new QuoteRefused(`tokenOut is not a token the ${r.chain} vault takes`);
  if (same(r.tokenIn, r.tokenOut)) throw new QuoteRefused('tokenIn is already a token the vault takes: deposit it directly');

  const base = `${KYBER.api}/${swaps.kyberChain}/api/v1`;
  const headers = { 'x-client-id': 'alcor-bridge' };
  const found = await fetchJson(
    `${base}/routes?${new URLSearchParams({ tokenIn: kyberToken(r.tokenIn), tokenOut: kyberToken(r.tokenOut), amountIn: r.amountIn })}`,
    { headers },
  );
  if (found.code !== 0 || !found.data?.routeSummary) throw new Error(`KyberSwap found no route: ${found.message}`);
  const built = await fetchJson(`${base}/route/build`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({
      routeSummary: found.data.routeSummary,
      sender: swaps.router,
      recipient: swaps.router,
      slippageTolerance: r.slippageBps,
    }),
  });
  if (built.code !== 0 || !built.data?.data) throw new Error(`KyberSwap could not build the route: ${built.message}`);
  // The router hands the swap only to an aggregator it lists; any other address would revert there.
  if (!same(String(built.data.routerAddress), KYBER.router)) {
    throw new Error(`KyberSwap answered with router ${built.data.routerAddress}, not the listed ${KYBER.router}`);
  }

  const expectedOut = BigInt(built.data.amountOut);
  const native = same(r.tokenIn, ZERO);
  return {
    chain: r.chain,
    provider: 'kyberswap',
    router: swaps.router,
    /** Which entry to call: the native coin goes in as value, an ERC-20 by a Permit2 signature. */
    call: native ? 'swapNativeAndDeposit' : 'swapAndDeposit',
    value: native ? r.amountIn : '0',
    swap: {
      tokenIn: r.tokenIn,
      amountIn: r.amountIn,
      swapper: KYBER.router,
      data: String(built.data.data),
      tokenOut: r.tokenOut,
      minOut: ((expectedOut * BigInt(10_000 - r.slippageBps)) / 10_000n).toString(),
    },
    expectedOut: expectedOut.toString(),
    /** The Permit2 signature transfer to sign: this token and amount, with the router as the spender. */
    permit2: native ? null : { address: PERMIT2, token: r.tokenIn, amount: r.amountIn, spender: swaps.router },
  };
}
