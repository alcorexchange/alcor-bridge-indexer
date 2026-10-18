/**
 * `/v1/swap/plan`: one token on one chain to another token on another chain —
 * everything the front end needs to show it and to sign it, or why it cannot be
 * done now.
 *
 * A journey swaps in up to two places, out of three:
 *
 * - **at the source**, on an Antelope chain (Telos included): the user's own
 *   transaction swaps on Alcor there before its transfer to the bridge, so the
 *   token that crosses is one the bridge carries. An Antelope transaction holds
 *   any number of actions, so it is still one signature. The transfer to the
 *   bridge sends the swap's least; what the swap gives above it stays with the
 *   sender (`leftover`).
 * - **on Telos**, by `route.alcor`: the crossing pays out to it, it swaps and
 *   sends what it bought on to the destination (bridgehop carries it).
 * - **at the destination**, on an Antelope chain, by `route.alcor` there: the
 *   crossing — a hop through Telos, or a withdrawal from it — pays out to it
 *   with the swap memo, and it delivers to the recipient.
 *
 * Never on Telos and at the destination both: Telos' `route.alcor` delivers to
 * another chain with no memo, so it cannot order a second swap there. Nothing
 * swaps on an EVM chain (AlcorRouter is not deployed).
 *
 * Every way that fits the two ends is planned, and the one that delivers the
 * most is the answer. Everything that decides whether a way works lives here:
 * routes open and within their bounds, a pool path, the least out above a
 * crossing's floor, the way back reachable, memos inside 256 bytes.
 */

import { ANTELOPE_SWAPS, ROUTE_MEMO } from '../../src/chains/swaps.ts';
import { fetchJson, HttpError } from '../../src/net/fetchJson.ts';
import { SETTLEMENT_CHAIN } from './config.ts';
import { decimalAmount, decimalUnits, parseAsset } from './units.ts';

/** A request the front end got wrong, as opposed to a journey that is not possible now: answered 400. */
export class PlanRefused extends Error {}

export type PlanRequest = {
  /** `<chain>:<SYMBOL>`, chain as `/v1/chains` names it: `polygon:POL`; on an Antelope chain any token, `xpr:LOAN@loan.token`. */
  from: string;
  /** `<chain>:<SYMBOL>`; on an Antelope chain any token, `vaulta:DOGE@dogecoinxxxx`. */
  to: string;
  /** In whole tokens, a decimal: `1233`, `0.5`. */
  amount: string;
  /** Who receives on the destination chain: a 0x address, or an account. */
  recipient: string;
  /** Who sends on the source chain: where the token goes back to if it is never swapped. */
  sender: string;
  /** In basis points: 50 is half a percent. Every swap on the way takes it. */
  slippageBps: number;
  /** How long a swap may wait for its price, from now. */
  deadlineSeconds: number;
};

/** A row of `/v1/routes`, the fields read here. */
export type PlanRoute = {
  symbol: string;
  precision: number;
  from: string;
  to: string;
  via: string | null;
  open: boolean;
  reason?: string;
  min: string;
  max: string | null;
  how: { deposit?: { token: string | null }; transfer?: { contract?: string | null } };
};

/** A chain of `/v1/chains`' `sources`, the fields read here. */
export type PlanChain = {
  id: string;
  name: string;
  kind?: string;
  chainId?: number | string;
  domain?: string;
  contracts?: { vault: string | null };
  timing?: { deposit?: { seconds: number }; withdrawal?: { seconds: number } | null };
};

/** One transfer of Alcor's `getRoute` answer. `<account>` in the memo stands for the receiver. */
export type RouteTransfer = { tokenContract: string; to: string; quantity: string; memo: string };

/** Alcor's answer for a swap, as read here. */
export type Quote = {
  /** What the swap gives now, a decimal in the token out. */
  output: string;
  decimals: number;
  /** In percent, as Alcor writes it. */
  priceImpact: string;
  pools: number[];
  /** What to send to swap it, the receiver still `<account>`. */
  transfers: RouteTransfer[];
};

/**
 * Alcor's best exactIn route on `chain` for `receiver`, or null when it has none;
 * each leg of `transfers` asks for its share of the output less `slippageBps`.
 */
export type Quoter = (
  chain: string, input: string, output: string, amount: string, receiver: string, slippageBps: number,
) => Promise<Quote | null>;

/** What the plan reads from Telos and the Antelope chains; null when it cannot be read now. */
export type ChainReader = {
  /** Whether account `name` exists on `chain` (an id of `/v1/chains`, or Telos). */
  account(chain: string, name: string): Promise<boolean | null>;
  /** The precision of token `symbol` of `contract` on `chain`; false when there is no such token. */
  precision(chain: string, contract: string, symbol: string): Promise<number | false | null>;
};

export type PlanContext = {
  routes: PlanRoute[];
  chains: PlanChain[];
  /** The bridge's accounts on Telos: the ledger, and bridgehop (null until it is deployed). */
  settlement: { bridge: string; hop: string | null };
  quote: Quoter;
  read: ChainReader;
  now: number;
};

/** About how long the executor takes to swap an order once it lands, in seconds. */
const SWAP_SECONDS = 5;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ACCOUNT = /^[a-z1-5.]{1,12}$/;
const MIRROR = 'wrap.alcor';
const TELOS: PlanChain = { id: SETTLEMENT_CHAIN, name: 'Telos', kind: 'antelope' };

const isAntelope = (c: PlanChain): boolean => c.kind === 'antelope';
const domainOf = (c: PlanChain): string => String(c.domain ?? c.chainId);
const routeOf = (chain: string): string | null => ANTELOPE_SWAPS[chain]?.route ?? null;

/** A token on a chain; `contract` null on an EVM chain, where only the bridge's tokens are named, by symbol. */
type Token = { chain: string; symbol: string; contract: string | null };
const sameToken = (a: Token, b: Token): boolean => a.chain === b.chain && a.symbol === b.symbol && a.contract === b.contract;
/** How Alcor's API names a token: `bnb-wrap.alcor`. */
const tokenId = (t: Token): string => `${t.symbol.toLowerCase()}-${t.contract}`;

function side(text: string, what: string): { chain: string; symbol: string; contract: string | null } {
  const m = /^([a-z0-9-]+):([A-Z]{1,7})(?:@([a-z1-5.]{1,12}))?$/.exec(text);
  if (!m) throw new PlanRefused(`${what} is <chain>:<SYMBOL>, like polygon:POL`);
  return { chain: m[1], symbol: m[2], contract: m[3] ?? null };
}

/** A recipient or sender on `c`, in the spelling the ledger stores: lowercase hex, or the account. */
function party(c: PlanChain, text: string, what: string): string {
  if (isAntelope(c)) {
    if (!ACCOUNT.test(text)) throw new PlanRefused(`${what} on ${c.name} is an account name`);
    return text;
  }
  if (!EVM_ADDRESS.test(text) || /^0x0{40}$/i.test(text)) throw new PlanRefused(`${what} on ${c.name} is a non-zero 0x address`);
  return text.toLowerCase();
}

/** `units` at `precision` decimals with every decimal written, as an Antelope asset is: `0.15418631`. */
function decimalFixed(units: bigint, precision: number): string {
  if (precision === 0) return units.toString();
  const text = units.toString().padStart(precision + 1, '0');
  return `${text.slice(0, -precision)}.${text.slice(-precision)}`;
}

/** An Antelope asset: `2.766601 USDC`. */
const assetText = (units: bigint, precision: number, symbol: string): string => `${decimalFixed(units, precision)} ${symbol}`;

/** What the quote gives, in units of the token out; any digits past its precision dropped. */
function quotedUnits(q: Quote): bigint {
  const [whole, fraction = ''] = q.output.split('.');
  return decimalUnits(fraction ? `${whole}.${fraction.slice(0, q.decimals)}` : whole, q.decimals);
}

/** `expected` less the slippage, rounded down. */
const lessSlippage = (expected: bigint, slippageBps: number): bigint => (expected * BigInt(10_000 - slippageBps)) / 10_000n;

/** The price impact of swaps one after another, in percent: each takes its share of what the one before left. */
function combinedImpact(swaps: SwapStep[]): string {
  const kept = swaps.reduce((k, s) => k * (1 - (Number(s.priceImpact) || 0) / 100), 1);
  return ((1 - kept) * 100).toFixed(2);
}

type Unavailable = { possible: false; reason: string };
const no = (reason: string): Unavailable => ({ possible: false, reason });

/**
 * Why `recipient` could not take a delivery on `target`, or null.
 *
 * A delivery to another chain is a withdrawal, and one that is never taken
 * comes back to the hop and goes out to the same place again, a withdrawal TTL
 * per try — it never returns home. So the place must take it: on an Antelope
 * chain an account that exists, and not one of the bridge's own (the vault, the
 * route, the token); on an EVM chain not the vault itself. An account that does
 * not exist yet would also be a prize for whoever registers the name first.
 */
async function undeliverable(target: PlanChain, recipient: string, read: ChainReader): Promise<string | null> {
  const own = [target.contracts?.vault, routeOf(target.id), MIRROR].filter(Boolean).map((a) => a!.toLowerCase());
  if (own.includes(recipient)) return `${recipient} is the bridge's own account on ${target.name}, not a recipient`;
  if (!isAntelope(target)) return null;
  const exists = await read.account(target.id, recipient);
  if (exists === null) return `cannot check now that ${recipient} exists on ${target.name}`;
  return exists ? null : `${recipient} does not exist on ${target.name}: create the account first`;
}

/** One swap of a journey, as the answer shows it. */
type SwapStep = {
  chain: string;
  /** `sender`: in the user's own transaction; `route.alcor`: by the bridge's swap contract there. */
  by: 'sender' | 'route.alcor';
  input: string;
  expected: string;
  least: string;
  priceImpact: string;
  pools: number[];
};

type Transfer = { account: string; name: 'transfer'; data: { from: string; to: string; quantity: string; memo: string } };

/** What the user signs on the source chain: the whole journey starts there. */
type Sign =
  | { kind: 'actions'; chain: string; actions: Transfer[] }
  | { kind: 'deposit'; chain: string; vault: string | null; token: string | null; telosTo: string; refundTo: string; memo: string };

/** The bridge's routes and chains, as the plan asks about them. */
class Network {
  private readonly ctx: PlanContext;

  constructor(ctx: PlanContext) {
    this.ctx = ctx;
  }

  chain(id: string): PlanChain | undefined {
    // Sui is a direct route to Telos only; no swap or hop is planned through it yet.
    return id === SETTLEMENT_CHAIN ? TELOS : this.ctx.chains.find((c) => c.id === id && c.kind !== 'sui');
  }

  /** The route between Telos and a chain, or between two chains through Telos (a hop's row). */
  route(symbol: string, from: string, to: string): PlanRoute | undefined {
    const via = from !== SETTLEMENT_CHAIN && to !== SETTLEMENT_CHAIN ? SETTLEMENT_CHAIN : null;
    return this.ctx.routes.find((x) => x.symbol === symbol && x.from === from && x.to === to && (x.via ?? null) === via);
  }

  /** The canonical precision of the bridge's token `symbol`, the same on every route. */
  precision(symbol: string): number {
    return this.ctx.routes.find((x) => x.symbol === symbol)!.precision;
  }

  /** The contract of the bridge's token `symbol` on an Antelope chain; null when the bridge carries none there. */
  contractOf(chain: string, symbol: string): string | null {
    if (chain === SETTLEMENT_CHAIN) return this.ctx.routes.some((x) => x.symbol === symbol) ? MIRROR : null;
    return this.route(symbol, chain, SETTLEMENT_CHAIN)?.how.transfer?.contract ?? null;
  }

  /** The bridge's token `symbol` as it is on `chain`. */
  token(chain: string, symbol: string): Token {
    return { chain, symbol, contract: this.contractOf(chain, symbol) };
  }

  /** The bridge's tokens that cross from `chain` to Telos; on Telos, every one. */
  carriedFrom(chain: string): string[] {
    const from = this.ctx.routes.filter((x) => (chain === SETTLEMENT_CHAIN || (x.from === chain && x.to === SETTLEMENT_CHAIN)) && !x.via);
    return [...new Set(from.map((x) => x.symbol))];
  }
}

/** Why `amount` of `symbol` cannot cross from `from` to `to` now (to or from Telos, or a hop through it), or null. */
function crossingRefusal(net: Network, symbol: string, from: string, to: string, amount: bigint): string | null {
  const r = net.route(symbol, from, to);
  const fmt = (u: bigint | string) => `${decimalAmount(u, net.precision(symbol))} ${symbol}`;
  const src = net.chain(from)!.name;
  const dst = net.chain(to)!.name;
  if (!r) return `${symbol} does not cross from ${src} to ${dst}`;
  if (!r.open) return r.reason ?? `${symbol} from ${src} to ${dst} is closed`;
  if (amount < BigInt(r.min)) return `at least ${fmt(r.min)} crosses from ${src} to ${dst}`;
  if (r.max !== null && amount > BigInt(r.max)) return `at most ${fmt(r.max)} crosses from ${src} to ${dst} now`;
  return null;
}

/** Why a crossing from `source` could not come back there if it is never delivered, or null. */
function wayBackRefusal(net: Network, symbol: string, source: PlanChain, amount: bigint): string | null {
  const home = net.route(symbol, SETTLEMENT_CHAIN, source.id);
  const fmt = (u: bigint | string) => `${decimalAmount(u, net.precision(symbol))} ${symbol}`;
  if (!home) return `${symbol} has no way back to ${source.name}`;
  if (amount < BigInt(home.min)) return `at least ${fmt(home.min)}: the way back to ${source.name} takes no less`;
  return null;
}

/**
 * One way through: the bridge's token that crosses, and where the bridge swaps
 * it — on Telos, at the destination, or nowhere (then the swap at the source
 * already bought the token out).
 */
type Way = { carrier: string; order: 'telos' | 'destination' | null };

/** Every way that fits the two ends, in the order a refusal is reported when none works. */
function waysFor(net: Network, source: PlanChain, target: PlanChain, input: Token, output: Token): Way[] {
  const swapsAtSource = isAntelope(source) && ANTELOPE_SWAPS[source.id] !== undefined;
  const swapsOnTelos = source.id !== SETTLEMENT_CHAIN && routeOf(SETTLEMENT_CHAIN) !== null;
  const swapsAtDestination = isAntelope(target) && target.id !== SETTLEMENT_CHAIN && routeOf(target.id) !== null;
  // What a swap on Telos buys: the token out itself on Telos, or the bridge's token that crosses on as it.
  const outputOnTelos = target.id === SETTLEMENT_CHAIN || (
    sameToken(output, net.token(target.id, output.symbol)) && net.route(output.symbol, SETTLEMENT_CHAIN, target.id) !== undefined
  );
  const bought: Token = { chain: SETTLEMENT_CHAIN, symbol: output.symbol, contract: target.id === SETTLEMENT_CHAIN ? output.contract : MIRROR };
  const ways: Way[] = [];
  for (const carrier of net.carriedFrom(source.id)) {
    const swappedAtSource = !sameToken(net.token(source.id, carrier), input);
    if (swappedAtSource && !swapsAtSource) continue;
    if (swapsOnTelos && outputOnTelos && !sameToken(net.token(SETTLEMENT_CHAIN, carrier), bought)) ways.push({ carrier, order: 'telos' });
    if (target.id !== SETTLEMENT_CHAIN && !net.route(carrier, SETTLEMENT_CHAIN, target.id)) continue;
    const arrives = net.token(target.id, carrier);
    if (swapsAtDestination && !sameToken(arrives, output)) ways.push({ carrier, order: 'destination' });
    if (swappedAtSource && sameToken(arrives, output)) ways.push({ carrier, order: null });
  }
  return ways;
}

type Job = {
  ctx: PlanContext;
  net: Network;
  source: PlanChain;
  target: PlanChain;
  input: Token;
  output: Token;
  precision: number;
  amountIn: bigint;
  recipient: string;
  sender: string;
  slippageBps: number;
  deadline: number;
};

export async function swapPlan(r: PlanRequest, ctx: PlanContext) {
  const net = new Network(ctx);
  const from = side(r.from, 'from');
  const to = side(r.to, 'to');
  if (!Number.isInteger(r.slippageBps) || r.slippageBps < 1 || r.slippageBps > 2000) throw new PlanRefused('slippageBps is 1 to 2000');
  if (!Number.isInteger(r.deadlineSeconds) || r.deadlineSeconds < 60 || r.deadlineSeconds > ROUTE_MEMO.maxWait) {
    throw new PlanRefused(`deadlineSeconds is 60 to ${ROUTE_MEMO.maxWait}`);
  }
  const source = net.chain(from.chain);
  if (!source) throw new PlanRefused(`from: no chain ${from.chain}; chains are ${[SETTLEMENT_CHAIN, ...ctx.chains.map((c) => c.id)].join(', ')}`);
  const target = net.chain(to.chain);
  if (!target) throw new PlanRefused(`to: no chain ${to.chain}`);
  if (source.id === target.id) return no(`both ends on ${source.name} is a swap on Alcor there; no plan is needed`);

  const input = resolve(net, source, from, 'from');
  const output = resolve(net, target, to, 'to');
  if (input.symbol === output.symbol && sameToken(input, net.token(source.id, input.symbol))
    && sameToken(output, net.token(target.id, output.symbol))) {
    return no('the same token on both ends is a plain crossing or a hop: see /v1/routes');
  }

  const recipient = party(target, r.recipient, 'recipient');
  const sender = party(source, r.sender, 'sender');

  const precision = await precisionOf(net, ctx.read, source, input);
  let amountIn: bigint;
  try {
    amountIn = decimalUnits(r.amount, precision);
  } catch {
    throw new PlanRefused(`amount is a decimal with at most ${precision} places`);
  }
  if (amountIn <= 0n) throw new PlanRefused('amount is positive');

  const refusal = await undeliverable(target, recipient, ctx.read);
  if (refusal) return no(refusal);

  const ways = waysFor(net, source, target, input, output);
  if (!ways.length) return no(`no way from ${input.symbol} on ${source.name} to ${output.symbol} on ${target.name}`);

  // Ways through one carrier ask for the same swap at the source: ask Alcor once.
  const asked = new Map<string, Promise<Quote | null>>();
  const quote: Quoter = (...args) => {
    const key = args.join(' ');
    if (!asked.has(key)) asked.set(key, ctx.quote(...args));
    return asked.get(key)!;
  };
  const job: Job = {
    ctx: { ...ctx, quote }, net, source, target, input, output, precision, amountIn, recipient, sender,
    slippageBps: r.slippageBps, deadline: ctx.now + r.deadlineSeconds,
  };
  const tried = await Promise.all(ways.map((way) => planWay(job, way).then(
    (plan) => ({ way, plan, error: null }),
    (error: Error) => ({ way, plan: null, error }),
  )));
  for (const t of tried) if (t.error) console.warn(`plan ${r.from} → ${r.to}: the way through ${t.way.carrier} failed: ${t.error.message}`);
  const done = tried.flatMap((t) => (t.plan?.possible ? [t.plan] : []));
  if (done.length) {
    // The most delivered; between equals, fewer swaps.
    done.sort((a, b) => {
      const more = BigInt(b.to.raw) - BigInt(a.to.raw);
      return more !== 0n ? (more > 0n ? 1 : -1) : a.swaps.length - b.swaps.length;
    });
    return done[0];
  }
  const refused = tried.find((t) => t.plan && !t.plan.possible);
  if (refused) return refused.plan as Unavailable;
  throw tried[0].error;
}

/** A side of the request as a token on its chain, the contract filled in for the bridge's own. */
function resolve(net: Network, chain: PlanChain, s: ReturnType<typeof side>, what: string): Token {
  if (!isAntelope(chain)) {
    if (s.contract) throw new PlanRefused(`${what} names a token on ${chain.name} by its symbol alone`);
    return { chain: chain.id, symbol: s.symbol, contract: null };
  }
  const contract = s.contract ?? net.contractOf(chain.id, s.symbol);
  if (!contract) throw new PlanRefused(`${what}: ${s.symbol} is not a bridge token on ${chain.name}; name its contract: ${chain.id}:${s.symbol}@<contract>`);
  return { chain: chain.id, symbol: s.symbol, contract };
}

/** The input token's precision: its route's on an EVM chain, the token's own on an Antelope one. */
async function precisionOf(net: Network, read: ChainReader, chain: PlanChain, t: Token): Promise<number> {
  if (!isAntelope(chain)) {
    const r = net.route(t.symbol, chain.id, SETTLEMENT_CHAIN);
    if (!r) throw new PlanRefused(`from: ${t.symbol} does not cross from ${chain.name}`);
    return r.precision;
  }
  const p = await read.precision(chain.id, t.contract!, t.symbol);
  if (p === false) throw new PlanRefused(`from: no token ${t.symbol} of ${t.contract} on ${chain.name}`);
  if (p === null) throw new Error(`cannot read ${t.symbol}@${t.contract} on ${chain.name} now`);
  return p;
}

/**
 * The swap at the source as the user's transfers, checked: all of the input, to
 * venues Alcor lists on that chain, each with a least that is the carrier — and
 * the least they give together, which is what crosses.
 */
function sourceLegs(job: Job, q: Quote, carrier: Token): { transfers: RouteTransfer[]; least: bigint } | string {
  const venues = new Set(ANTELOPE_SWAPS[job.source.id].venues.map((v) => v.account));
  const carrierPrecision = job.net.precision(carrier.symbol);
  if (q.decimals !== carrierPrecision) return `${carrier.symbol} on ${job.source.name} is not at the bridge's precision`;
  if (!q.transfers.length) return `no pool path from ${job.input.symbol} to ${carrier.symbol} on ${job.source.name}`;
  let spent = 0n;
  let least = 0n;
  for (const t of q.transfers) {
    if (t.tokenContract !== job.input.contract || !venues.has(t.to)) return `Alcor on ${job.source.name} routes through ${t.to}, not a venue the plan knows`;
    const leg = parseAsset(t.quantity);
    if (leg.symbol !== job.input.symbol || leg.precision !== job.precision) return `Alcor on ${job.source.name} spends ${t.quantity}, not the input`;
    const asked = legLeast(t.memo);
    if (!asked) return `Alcor on ${job.source.name} sends a leg whose least cannot be read: ${t.memo}`;
    const [quantity, contract] = asked.split('@');
    const out = parseAsset(quantity);
    if (contract !== carrier.contract || out.symbol !== carrier.symbol || out.precision !== carrierPrecision) {
      return `Alcor on ${job.source.name} sends a leg that does not buy ${carrier.symbol}`;
    }
    spent += leg.units;
    least += out.units;
  }
  if (spent !== job.amountIn) return `Alcor on ${job.source.name} spends ${spent} units, not the ${job.amountIn} asked`;
  return { transfers: q.transfers, least };
}

/** The least a swap leg's memo asks for: `swapexactin#…#<account>#<least>#…` on an AMM, `<least>|min` on a book. */
function legLeast(memo: string): string | null {
  const amm = /^swapexactin#[^#]*#<account>#([^#]+@[a-z1-5.]{1,12})#\d+$/.exec(memo);
  if (amm) return amm[1];
  const book = /^([^|#]+@[a-z1-5.]{1,12})\|min$/.exec(memo);
  return book ? book[1] : null;
}

/** One way planned through, or why it does not go now. */
async function planWay(job: Job, way: Way) {
  const { ctx, net, source, target, input, output, recipient, sender, deadline, slippageBps } = job;
  const swaps: SwapStep[] = [];
  const parts: { what: string; seconds: number }[] = [];
  const carrierPrecision = net.precision(way.carrier);
  const fmtCarrier = (u: bigint) => assetText(u, carrierPrecision, way.carrier);
  const outFmt = (u: bigint | string, decimals: number) => `${decimalAmount(u, decimals)} ${output.symbol}`;

  // --- at the source: the user's own swap into the carrier -------------------------------
  const carrier = net.token(source.id, way.carrier);
  let crossing = job.amountIn;
  let swapTransfers: RouteTransfer[] = [];
  let leftover: { chain: string; asset: string; contract: string } | null = null;
  if (!sameToken(carrier, input)) {
    const q = await ctx.quote(source.id, tokenId(input), tokenId(carrier), decimalAmount(job.amountIn, job.precision), sender, slippageBps);
    if (!q) return no(`no pool path from ${input.symbol} to ${way.carrier} on ${source.name}`);
    const legs = sourceLegs(job, q, carrier);
    if (typeof legs === 'string') return no(legs);
    const expected = quotedUnits(q);
    crossing = legs.least;
    swapTransfers = legs.transfers.map((t) => ({ ...t, memo: t.memo.split('<account>').join(sender) }));
    swaps.push({
      chain: source.id, by: 'sender', input: assetText(job.amountIn, job.precision, input.symbol),
      expected: fmtCarrier(expected), least: fmtCarrier(crossing), priceImpact: q.priceImpact, pools: q.pools,
    });
    leftover = { chain: source.id, asset: fmtCarrier(expected - crossing), contract: carrier.contract! };
    parts.push({ what: `the swap on ${source.name}`, seconds: 0 });
  }
  if (crossing <= 0n) return no('the swap gives nothing at this amount');

  // --- the crossing and the bridge's swap -------------------------------------------------
  const homeLeg = `${domainOf(source)}:${sender}`;
  let expected: bigint;
  let least: bigint;
  let decimals: number;
  /** The memo of the bridge's swap, and where what arrived goes if it never swaps. */
  let memo: string | null = null;
  let back: string | null = null;
  /** Who the crossing is paid to on Telos (a deposit's beneficiary), and the memo it carries. */
  let telosTo: string;
  let telosMemo: string;
  let follow: string;

  if (way.order === 'telos') {
    const refusal = crossingRefusal(net, way.carrier, source.id, SETTLEMENT_CHAIN, crossing)
      ?? wayBackRefusal(net, way.carrier, source, crossing);
    if (refusal) return no(refusal);
    const route = routeOf(SETTLEMENT_CHAIN)!;
    const bought: Token = { chain: SETTLEMENT_CHAIN, symbol: output.symbol, contract: target.id === SETTLEMENT_CHAIN ? output.contract : MIRROR };
    const q = await ctx.quote(SETTLEMENT_CHAIN, tokenId(net.token(SETTLEMENT_CHAIN, way.carrier)), tokenId(bought), decimalAmount(crossing, carrierPrecision), route, slippageBps);
    if (!q) return no(`no pool path from ${way.carrier} to ${output.symbol} on Telos`);
    expected = quotedUnits(q);
    decimals = q.decimals;
    least = lessSlippage(expected, slippageBps);
    if (least <= 0n) return no('the swap gives nothing at this amount');
    if (target.id !== SETTLEMENT_CHAIN) {
      const outbound = net.route(output.symbol, SETTLEMENT_CHAIN, target.id)!;
      if (!outbound.open) return no(outbound.reason ?? `${output.symbol} to ${target.name} is closed`);
      if (outbound.precision !== decimals) return no(`${output.symbol} on Telos and on ${target.name} differ in precision`);
      if (least < BigInt(outbound.min)) return no(`the least out ${outFmt(least, decimals)} is under ${target.name}'s minimum, ${outFmt(outbound.min, decimals)}`);
      if (outbound.max !== null && expected > BigInt(outbound.max)) return no(`at most ${outFmt(outbound.max, decimals)} goes to ${target.name} now`);
    }
    swaps.push({
      chain: SETTLEMENT_CHAIN, by: 'route.alcor', input: fmtCarrier(crossing),
      expected: assetText(expected, decimals, output.symbol), least: assetText(least, decimals, output.symbol),
      priceImpact: q.priceImpact, pools: q.pools,
    });
    const toPlace = target.id === SETTLEMENT_CHAIN ? recipient : `${domainOf(target)}:${recipient}`;
    back = homeLeg;
    memo = `${toPlace}|${assetText(least, decimals, output.symbol)}@${bought.contract}|${deadline}|${back}`;
    telosTo = route;
    telosMemo = memo;
    follow = 'the deposit on /v1/transfers: swap.status, then swap.onward[0] for the last leg';
    parts.push({ what: `${source.name} to Telos`, seconds: source.timing?.deposit?.seconds ?? 0 });
    parts.push({ what: 'the swap on Telos', seconds: SWAP_SECONDS });
    if (target.id !== SETTLEMENT_CHAIN) parts.push({ what: `Telos to ${target.name}`, seconds: target.timing?.withdrawal?.seconds ?? 0 });
  } else {
    // The carrier crosses as it is: a deposit to Telos, a withdrawal from it, or a hop through it.
    const hop = source.id !== SETTLEMENT_CHAIN && target.id !== SETTLEMENT_CHAIN;
    const refusal = crossingRefusal(net, way.carrier, source.id, target.id, crossing)
      ?? (hop ? wayBackRefusal(net, way.carrier, source, crossing) : null);
    if (refusal) return no(refusal);
    if (source.id !== SETTLEMENT_CHAIN) parts.push({ what: `${source.name} to Telos`, seconds: source.timing?.deposit?.seconds ?? 0 });
    if (target.id !== SETTLEMENT_CHAIN) parts.push({ what: `Telos to ${target.name}`, seconds: target.timing?.withdrawal?.seconds ?? 0 });

    let payee = recipient;
    if (way.order === 'destination') {
      const route = routeOf(target.id)!;
      const q = await ctx.quote(target.id, tokenId(net.token(target.id, way.carrier)), tokenId(output), decimalAmount(crossing, carrierPrecision), route, slippageBps);
      if (!q) return no(`no pool path from ${way.carrier} to ${output.symbol} on ${target.name}`);
      expected = quotedUnits(q);
      decimals = q.decimals;
      least = lessSlippage(expected, slippageBps);
      if (least <= 0n) return no('the swap gives nothing at this amount');
      swaps.push({
        chain: target.id, by: 'route.alcor', input: fmtCarrier(crossing),
        expected: assetText(expected, decimals, output.symbol), least: assetText(least, decimals, output.symbol),
        priceImpact: q.priceImpact, pools: q.pools,
      });
      // Never swapped, what arrived goes to the recipient as it is: `back` left out is `to`.
      back = recipient;
      memo = `${recipient}|${assetText(least, decimals, output.symbol)}@${output.contract}|${deadline}`;
      payee = route;
      parts.push({ what: `the swap on ${target.name}`, seconds: SWAP_SECONDS });
    } else {
      expected = crossing;
      least = crossing;
      decimals = carrierPrecision;
    }

    if (source.id === SETTLEMENT_CHAIN) {
      // A withdrawal, `<domain>:<recipient>[:<fee>[:<memo>]]`: its memo is what the far side pays out with.
      telosTo = ctx.settlement.bridge;
      telosMemo = memo ? `${domainOf(target)}:${payee}:0:${memo}` : `${domainOf(target)}:${payee}`;
      follow = memo ? 'the withdrawal on /v1/transfers: its swap, once paid out to route.alcor' : 'the withdrawal on /v1/transfers';
    } else if (!hop) {
      telosTo = recipient;
      telosMemo = '';
      follow = 'the deposit on /v1/transfers';
    } else {
      // A hop: where it goes, where it goes back to, and the memo the far side pays out with.
      if (!ctx.settlement.hop) return no('bridgehop is not deployed on Telos');
      telosTo = ctx.settlement.hop;
      telosMemo = `${domainOf(target)}:${payee}|${homeLeg}${memo ? `|${memo}` : ''}`;
      follow = memo ? 'the hop on /v1/hops/<deposit key>: its swap, then delivered' : 'the hop on /v1/hops/<deposit key>';
    }
  }

  // --- what the user signs ------------------------------------------------------------------
  let sign: Sign;
  if (isAntelope(source)) {
    const vault = source.id === SETTLEMENT_CHAIN ? ctx.settlement.bridge : source.contracts?.vault ?? null;
    if (!vault) return no(`no vault on ${source.name}`);
    // To Telos the vault's memo is `<telos account>[:<memo>]`; on Telos itself it is the withdrawal's own.
    const toBridge = source.id === SETTLEMENT_CHAIN ? telosMemo : telosMemo ? `${telosTo}:${telosMemo}` : telosTo;
    sign = {
      kind: 'actions',
      chain: source.id,
      actions: [
        ...swapTransfers.map((t): Transfer => ({
          account: t.tokenContract, name: 'transfer', data: { from: sender, to: t.to, quantity: t.quantity, memo: t.memo },
        })),
        { account: carrier.contract!, name: 'transfer', data: { from: sender, to: vault, quantity: fmtCarrier(crossing), memo: toBridge } },
      ],
    };
  } else {
    sign = {
      kind: 'deposit', chain: source.id, vault: source.contracts?.vault ?? null,
      token: net.route(way.carrier, source.id, SETTLEMENT_CHAIN)?.how.deposit?.token ?? null,
      telosTo, refundTo: sender, memo: telosMemo,
    };
  }
  for (const m of sign.kind === 'actions' ? sign.actions.map((a) => a.data.memo) : [sign.memo]) {
    const bytes = Buffer.byteLength(m);
    if (bytes > ROUTE_MEMO.maxBytes) return no(`a memo is ${bytes} bytes, over ${ROUTE_MEMO.maxBytes}`);
  }

  return {
    possible: true as const,
    from: {
      chain: source.id, symbol: input.symbol, contract: input.contract,
      amount: decimalAmount(job.amountIn, job.precision), raw: job.amountIn.toString(), precision: job.precision,
    },
    to: {
      chain: target.id, symbol: output.symbol, contract: output.contract, recipient,
      expected: decimalAmount(expected, decimals), least: decimalAmount(least, decimals), raw: expected.toString(), precision: decimals,
    },
    /** The bridge's token that crosses, and how much of it. */
    carried: { symbol: way.carrier, amount: decimalAmount(crossing, carrierPrecision) },
    /** Every swap on the way, in order. */
    swaps,
    priceImpact: combinedImpact(swaps),
    slippageBps,
    /** What the swap at the source gives above its least: it stays with the sender there. */
    leftover,
    deadline,
    memo,
    back,
    sign,
    /**
     * Who finishes the last leg: on an EVM chain the withdrawal carries no fee,
     * so the user releases it from their own wallet; on an Antelope chain the
     * relayer delivers it.
     */
    release: target.id === SETTLEMENT_CHAIN ? null : isAntelope(target) ? 'relayer' : 'user',
    eta: { seconds: parts.reduce((a, p) => a + p.seconds, 0), parts },
    follow,
  };
}

/**
 * Alcor's router on `chain`, exactIn, for `receiver` — as the executor asks it
 * for an order there, and as the user's own swap at the source is built. Null
 * when it has no path: no route in its answer, a 400 (`Unknown token` for a
 * token no pool holds) or a 404 (`No route`). A 5xx or a network failure is
 * thrown — that is Alcor failing, not an answer.
 */
export const alcorQuote: Quoter = async (chain, input, output, amount, receiver, slippageBps) => {
  const swaps = ANTELOPE_SWAPS[chain];
  if (!swaps) return null;
  const q = new URLSearchParams({
    tradeType: 'exactIn', input, output, amount, slippage: String(slippageBps / 100), receiver, maxHops: '3',
  });
  let answer;
  try {
    answer = await fetchJson(`${swaps.alcorApi}/api/v3/swapRouter/getRoute?${q}`);
  } catch (err) {
    if (err instanceof HttpError && (err.status === 400 || err.status === 404)) return null;
    throw err;
  }
  if (answer.error || !answer.routes?.length || !answer.output?.amount) return null;
  return {
    output: String(answer.output.amount),
    decimals: Number(answer.output.decimals),
    priceImpact: String(answer.priceImpact ?? ''),
    pools: (answer.routes as { hops?: { pool: number }[] }[]).flatMap((x) => (x.hops ?? []).map((h) => Number(h.pool))),
    transfers: (answer.transfers ?? []) as RouteTransfer[],
  };
};
