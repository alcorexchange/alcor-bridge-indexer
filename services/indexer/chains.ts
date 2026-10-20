/**
 * What this deployment is connected to, and how far along each side is.
 *
 * One endpoint for the question a monitor actually asks — "is everything moving?"
 * — across every chain a route exists to, rather than the single pair this process
 * happens to be configured for.
 *
 * That difference is the point. The Telos half is shared: one state-history
 * stream, one finality tree, one bridge contract whose withdrawals are bound for
 * every chain there is a route to. Only the source side is per chain, and what it
 * needs is small: a light client that is not behind, and a top block that has
 * actually been proved.
 *
 * Every number here is read from a chain, not from this process's own bookkeeping,
 * so a stalled follower shows up as a gap rather than as silence.
 */

import type { EvmChain } from '../../src/chains/evm.ts';
import { antelopeDepositEta, antelopeWithdrawalEta, depositEta, nearDepositEta, nearWithdrawalEta, suiDepositEta, suiWithdrawalEta, withdrawalEta, type Eta } from '../../src/chains/eta.ts';
import { NEAR_ACCOUNT } from '../../src/chains/near.ts';
import { antelopeVaults } from '../../src/chains/antelope.ts';
import { HOP_MEMO, antelopeSwapsView, evmSwapsView } from '../../src/chains/swaps.ts';
import { hexToName } from '../../src/proof/pack.ts';
import type { BlockrootKeeper } from './blockroot.ts';
import { assetOfRoute } from './fast.ts';
import { execFor, selector, type Exec } from '../../src/evm/exec.ts';
import { antelopeRpc, getTableRows } from '../../src/net/antelope.ts';
import { SETTLEMENT_CHAIN, type AntelopeConfig, type IndexerConfig, type NearConfig, type SuiConfig } from './config.ts';
import { nearVaultState } from '../../src/near/client.ts';
import { nearRpc } from '../../src/near/rpc.ts';
import { nearRouteOf } from './nearVault.ts';
import { outflowLeftNow, vaultState } from '../../src/sui/client.ts';
import { suiGraphql } from '../../src/sui/proof.ts';
import { epochBacklog } from './parlia.ts';
import { trustedSet } from '../../src/polygon/proof.ts';
import { comet, heimdallOf, latestHeight } from '../../src/polygon/heimdall.ts';
import { periodAt } from '../../src/evm/beacon.ts';

export type ProvedTop = { block: number; hash: string; at: string; signers: number } | null;

export type ChainStatus = {
  id: string;
  name: string;
  chainId: number;
  strategy: string;
  /** Head as the chain itself reports it. */
  head: number | null;
  /** The highest block this deployment has PROVED on Telos, not merely seen. */
  provedTop: ProvedTop;
  /** How far the proved top is behind the head, in blocks. */
  behind: number | null;
  lightClient: { account: string; contract: string | null };
  gateway: string | null;
  contracts: { vault: string | null; withdrawals: string | null };
  /** The upkeep each consensus needs, and whether it is current. */
  upkeep: Record<string, unknown> | null;
  /** Whether a deposit here can be proved at all: on every EVM chain followed, it can. */
  deposits: { supported: true };
  /**
   * How long each direction takes, and where the time goes.
   *
   * Per chain because the answer is per chain by an order of magnitude — seconds
   * on BSC, a quarter of an hour on Ethereum — and a front end that shows one
   * number for all of them is wrong on most of them. A withdrawal is null where
   * the chain has no withdrawals contract; `active.reason` says so.
   */
  timing: { deposit: Eta; withdrawal: Eta | null };
  /**
   * Whether each direction is open right now, for a button to be greyed on.
   *
   * Not one fact but the conjunction of four, which is why it is computed here
   * rather than left to every caller: the mechanism has to exist, the contract
   * has to be deployed, the bridge's route has to be open, and the vault must
   * not be paused. A guardian halting a vault is invisible in the other three.
   */
  active: { deposits: boolean; withdrawals: boolean; reason?: string };
  routes: { symbol: string; scale: string; deposits: boolean; withdrawals: boolean }[];
  /** A crossing that starts here in a swap: AlcorRouter and the quote for it; null where it is not deployed. */
  swaps: ReturnType<typeof evmSwapsView>;
  error?: string;
};

// The source list lives in the config, computed once, so this endpoint and the
// followers cannot disagree about which chains exist.

/** The highest proved block in a light client's `headers` table. */
async function provedTop(cfg: IndexerConfig, account: string): Promise<ProvedTop> {
  const res = await antelopeRpc(cfg.savanna, '/v1/chain/get_table_rows', {
    code: account,
    scope: account,
    table: 'headers',
    // The `by_number` index, walked from the top: the primary key is a truncated
    // block hash, so the newest row is nowhere near the end of it.
    index_position: 2,
    key_type: 'i64',
    reverse: true,
    limit: 1,
    json: true,
  });
  const row = res?.rows?.[0];
  if (!row) return null;
  return {
    block: Number(row.block_number),
    hash: String(row.block_hash),
    at: String(row.at),
    signers: Number(row.signers ?? 0),
  };
}

/** What keeps each consensus provable, and whether it is current. */
export async function upkeepOf(
  cfg: IndexerConfig,
  chain: EvmChain,
  accounts: { lightClient: string },
): Promise<Record<string, unknown> | null> {
  if (chain.strategy === 'parlia') {
    const backlog = await epochBacklog({ evm: chain, savanna: cfg.savanna, accounts }).catch(() => null);
    if (!backlog) return null;
    return {
      kind: 'validator sets',
      action: 'updateset',
      stored: backlog.stored,
      chain: backlog.head,
      lag: backlog.lag,
      // Every epoch is installed, in order; a set signs nothing past the next
      // one's switch, so a lag above one holds proofs back.
      note: 'epochs of 1000 blocks, installed in order, one per epoch',
    };
  }
  if (chain.strategy === 'milestone') {
    const trusted = await trustedSet(cfg.savanna, accounts.lightClient).catch(() => null);
    if (!trusted) return null;
    const h = heimdallOf(chain);
    const head = await latestHeight(h).catch(() => null);
    const current = head === null ? null : String((await comet(h, `commit?height=${head - 1}`)).signed_header.header.validators_hash).toLowerCase() === trusted.hash;
    return {
      kind: 'validator set',
      action: 'updateset',
      fromHeight: trusted.fromHeight,
      installedFromHeaderAgo: Math.round(Date.now() / 1000 - trusted.time),
      validators: trusted.members.length,
      current,
      // Heimdall's powers move about hourly; the relayer installs each set in
      // order, and a proof is accepted only under the exact set installed.
      note: 'one set per change of voting power, installed in order by the polygon relayer',
    };
  }
  if (chain.strategy === 'beacon') {
    const rows = await getTableRows<{ period: number }>(cfg.savanna, {
      code: accounts.lightClient,
      scope: accounts.lightClient,
      table: 'roots',
      limit: 1000,
    }).catch(() => []);
    if (!rows.length) return null;
    const stored = Math.max(...rows.map((r) => Number(r.period)));
    // The period signing now, from the clock rather than from a beacon node:
    // one fewer thing to be down when the question is whether we are behind.
    const head = chain.beaconGenesisTime ? periodAt(chain.beaconGenesisTime, Date.now() / 1000) : null;
    return {
      kind: 'sync committee',
      action: 'updcommit',
      stored,
      head,
      // One behind is the next committee not rotated in yet; two cannot be
      // skipped over and stops deposits.
      lag: head === null ? null : head - stored,
      periods: rows.length,
    };
  }
  return null;
}

/**
 * Whether the vault itself is halted, read from the vault.
 *
 * The bridge's own `routes` table cannot answer this: it lives on Telos, and a
 * guardian pausing a vault on the far side never touches it. Tested on BSC
 * testnet — `halt()` from a guardian key stopped both directions while every
 * Telos-side flag stayed open — so a status that skipped this would have shown a
 * halted chain as active.
 *
 * Null when the vault cannot be reached, which is not the same as "not paused"
 * and is reported as its own state.
 */
async function vaultPaused(
  exec: Exec,
  vault: string,
): Promise<{ deposits: boolean; withdrawals: boolean } | null> {
  try {
    const [d, w] = await Promise.all([
      exec.rpc('eth_call', [{ to: vault, data: selector('depositsPaused()') }, 'latest']),
      exec.rpc('eth_call', [{ to: vault, data: selector('withdrawalsPaused()') }, 'latest']),
    ]);
    return { deposits: BigInt(d) === 1n, withdrawals: BigInt(w) === 1n };
  } catch {
    return null;
  }
}

/** 2^256 − 1: what `AlcorVault.available` answers for a token with no limit. */
const UNLIMITED_OUTFLOW = (1n << 256n) - 1n;

/**
 * Each route with what its vault will still let out today, and the largest
 * withdrawal that can be paid out right now.
 *
 * Telos knows `backing` and `maxWithdrawal`; the vault's daily limit lives only
 * in the vault. A withdrawal over what is left of it is still accepted on Telos
 * and then waits on the far side for the limit to refill — so a front end that
 * showed only `available` would promise a payout that is not coming today.
 *
 * `outflowLeft` is canonical units, rounded down, or null when the token has no
 * limit. When the vault cannot be read, `outflowError` says why and there is no
 * `withdrawableNow`: unknown is not the same as unlimited.
 */
async function withOutflow<
  R extends { token: string; scale: string; available: string | null; maxWithdrawal: string },
>(exec: Exec, vault: string, routes: R[]) {
  const NATIVE = '0x' + '0'.repeat(40);
  return Promise.all(
    routes.map(async (r) => {
      try {
        const arg = r.token.slice(2).toLowerCase().padStart(64, '0');
        const vaultArg = vault.slice(2).toLowerCase().padStart(64, '0');
        const scale = BigInt(r.scale);
        const word = (hex: string, i: number) => BigInt('0x' + String(hex).slice(2 + i * 64, 2 + (i + 1) * 64));
        const [available, limit, asset, balance] = await Promise.all([
          exec.rpc('eth_call', [{ to: vault, data: selector('available(address)') + arg }, 'latest']),
          exec.rpc('eth_call', [{ to: vault, data: selector('limits(address)') + arg }, 'latest']),
          exec.rpc('eth_call', [{ to: vault, data: selector('assets(address)') + arg }, 'latest']),
          // What the vault holds is its balance, which is what the cap is checked against.
          r.token.toLowerCase() === NATIVE
            ? exec.rpc('eth_getBalance', [vault, 'latest'])
            : exec.rpc('eth_call', [{ to: r.token, data: selector('balanceOf(address)') + vaultArg }, 'latest']),
        ]);
        const raw = BigInt(available);
        const left = raw === UNLIMITED_OUTFLOW ? null : raw / scale;
        // `limits(token)` is (used, updated, perPeriod); `assets(token)` is
        // (scale, minDeposit, enabled, cap). Raw units both, scaled down here.
        const perPeriod = word(limit, 2);
        const cap = word(asset, 3);
        const held = BigInt(balance) / scale;
        const room = cap === 0n ? null : cap / scale - held;
        return {
          ...r,
          /** The vault's daily allowance for this token, canonical units; null when unmetered. */
          outflowPerDay: perPeriod === UNLIMITED_OUTFLOW ? null : (perPeriod / scale).toString(),
          outflowLeft: left === null ? null : left.toString(),
          withdrawableNow: withdrawableNow(r, left),
          /** The vault's own cap on what it holds of this token; null when uncapped. */
          vaultCap: cap === 0n ? null : (cap / scale).toString(),
          /** What it holds now, its balance. */
          vaultHeld: held.toString(),
          /** The most one deposit can add before the vault refuses `CapExceeded`; null when uncapped. */
          depositableNow: room === null ? null : (room < 0n ? 0n : room).toString(),
          vaultEnabled: word(asset, 2) === 1n,
        };
      } catch (err) {
        return { ...r, outflowError: (err as Error).message };
      }
    }),
  );
}

/**
 * The least of the bounds a withdrawal has right now. An uncapped spoke
 * (`available` null) and a vault with no daily limit (`outflowLeft` null) put
 * no bound of their own.
 */
export function withdrawableNow(r: { available: string | null; maxWithdrawal: string }, outflowLeft: bigint | null): string {
  const bounds = [
    ...(r.available === null ? [] : [BigInt(r.available)]),
    BigInt(r.maxWithdrawal),
    ...(outflowLeft === null ? [] : [outflowLeft]),
  ];
  return bounds.reduce((a, b) => (b < a ? b : a)).toString();
}

/**
 * Whether each direction is open, and every reason one is not.
 *
 * Four facts have to agree and they live in four places: the mechanism (this
 * repo), the contracts (the far chain), the route (Telos), and the vault's pause
 * flags (the far chain again). Any one of them closes the direction, so a caller
 * asking "can I deposit" would otherwise have to gather all four itself and get
 * the conjunction right.
 */
function activeOf(
  chain: EvmChain,
  routes: { deposits: boolean; withdrawals: boolean; vaultEnabled?: boolean }[],
  paused: { deposits: boolean; withdrawals: boolean } | null,
): ChainStatus['active'] {
  // A route open on Telos whose token the vault does not enable yet takes no
  // deposit: it would revert in the vault, at the depositor's gas.
  const openDeposit = routes.some((r) => r.deposits && r.vaultEnabled !== false);
  const openWithdrawal = routes.some((r) => r.withdrawals);
  const reasons: string[] = [];

  if (!chain.vault) reasons.push('no vault is deployed here');
  else if (!paused) reasons.push('the vault did not answer; its pause flags are unknown');

  if (!openDeposit) {
    reasons.push(
      routes.some((r) => r.deposits)
        ? 'the vault does not take these assets yet'
        : 'no route here has deposits open',
    );
  }
  else if (paused?.deposits) reasons.push('deposits are paused at the vault');

  if (!chain.withdrawals) reasons.push('no withdrawals contract is deployed here');
  else if (!openWithdrawal) reasons.push('no route here has withdrawals open');
  else if (paused?.withdrawals) reasons.push('withdrawals are paused at the vault');

  return {
    // `paused?.deposits === false` and not `!paused?.deposits`: a vault that did
    // not answer is unknown, and unknown is not open.
    deposits: openDeposit && paused?.deposits === false,
    withdrawals: Boolean(chain.withdrawals) && openWithdrawal && paused?.withdrawals === false,
    ...(reasons.length ? { reason: reasons.join('; ') } : {}),
  };
}

/** The bridge's listings, as its tables hold them: read once per status call, shared by every chain in it. */
type Ledger = { routes: any[]; assets: any[]; spokes: any[] };

async function readLedger(cfg: IndexerConfig): Promise<Ledger> {
  const table = (name: string) =>
    getTableRows<any>(cfg.savanna, { code: cfg.accounts.bridge, scope: cfg.accounts.bridge, table: name, limit: 200 });
  const [routes, assets, spokes] = await Promise.all([table('routes'), table('assets'), table('spokes')]);
  return { routes, assets, spokes };
}

/**
 * The routes the bridge holds for one domain, on the vault this deployment
 * follows there.
 *
 * Routes of a retired vault stay on Telos — a route is closed, never deleted —
 * but nothing can be deposited through them and a front end offering them
 * would be offering a dead end. So they are left out, and a chain with no vault
 * configured has no routes to show.
 */
function routesOf({ routes, assets, spokes }: Ledger, domain: string, vault: string | undefined) {
  return routes
    .filter((r) => String(r.domain) === domain)
    .filter((r) => !!vault && String(r.vault).toLowerCase() === vault.replace(/^0x/, '').toLowerCase())
    .map((r) => {
      const asset = assetOfRoute(assets, r);
      /**
       * A spoke holds no collateral over there: the far vault mints a mirror,
       * and what may still go is the room left under the spoke's cap on Telos.
       * An uncapped spoke has no bound at all, which is `null`, not a number.
       */
      const spoke = spokes.find((s) => String(s.route_id) === String(r.id));
      const available = spoke
        ? (BigInt(r.cap) === 0n ? null : (BigInt(r.cap) - BigInt(spoke.locked)).toString())
        : String(r.backing);
      const antelope = String(r.vault).length === 16;
      const ext = String(r.ext_token);
      return {
        /** `backing`: collateral over there. `spoke`: a mirror minted over there. */
        kind: spoke ? 'spoke' : 'backing',
        locked: spoke ? String(spoke.locked) : undefined,
        symbol: asset?.symbol ?? '',
        /** Canonical precision. A front end formatting without it is guessing. */
        precision: asset?.precision ?? 0,
        /**
         * The ERC-20 to approve and deposit, and the floor and ceiling to check
         * before asking anyone to sign.
         *
         * Without these a front end cannot build the transaction at all: it would
         * have to carry the token address per chain in its own source, which is
         * how one deployment ends up spending against another's token.
         */
        token: antelope ? null : '0x' + ext,
        /**
         * On an Antelope chain the token is a (contract, symbol) pair: the
         * mirror to send back (a spoke) or the native token to deposit (a backing route).
         */
        antelopeToken: antelope ? antelopeToken(ext) : undefined,
        minDeposit: String(r.min_deposit),
        cap: String(r.cap),
        scale: String(r.scale),
        /**
         * What this chain's vault holds for the supply circulating on Telos:
         * the route's `backing`, and so the most that can ever leave through
         * it. One withdrawal is further bounded by `maxWithdrawal`, and the
         * vault's daily outflow by `outflowLeft`; `withdrawableNow` is the
         * least of the three.
         */
        available,
        /** The route's `min_deposit`, which the bridge holds withdrawals to as well. */
        minWithdrawal: String(r.min_deposit),
        maxWithdrawal: String(r.max_withdrawal),
        /**
         * The largest deposit credited on an unfinalized proof — the fast path's
         * ceiling — and how many confirmations it must show. `"0"` means every
         * deposit waits for finality; an Antelope route has no fast path at all.
         */
        fastMax: String(r.optimistic_max),
        minConfirmations: Number(r.min_confirmations),
        deposits: Boolean(r.deposits_open),
        withdrawals: Boolean(r.withdrawals_open),
        /** The memo a withdrawal must carry: `<chainId>:0x<address>`, or an account name on an Antelope chain. */
        withdrawMemo: antelope ? `${domain}:<account>` : `${domain}:0x<recipient>`,
        /** What a deposit on that chain names in its memo; only an Antelope chain has one. */
        depositMemo: antelope ? '<telos account>[:<note>]' : undefined,
      };
    });
}

export async function chainsStatus(cfg: IndexerConfig, savannaState: Record<string, unknown>, keepers: Map<string, BlockrootKeeper>) {
  const ledger = await readLedger(cfg);
  // An Antelope chain's routes are the ledger's, so a node that does not answer still leaves them listed.
  const antelope = Promise.all(cfg.antelope.map((a) => antelopeStatus(cfg, ledger, a, keepers.get(a.chain.id)).catch((err) => ({
    id: a.chain.id,
    name: a.chain.name,
    kind: 'antelope',
    error: (err as Error).message,
    routes: antelopeRoutes(ledger, a.chain.domain),
  }))));
  const sources = await Promise.all(
    cfg.sources.map(async ({ chain, accounts, exec: urls }): Promise<ChainStatus> => {
      const base: ChainStatus = {
        id: chain.id,
        name: chain.name,
        chainId: chain.chainId,
        strategy: chain.strategy,
        head: null,
        provedTop: null,
        behind: null,
        lightClient: { account: accounts.lightClient, contract: chain.lightClient ?? null },
        gateway: accounts.gateway,
        contracts: { vault: chain.vault ?? null, withdrawals: chain.withdrawals ?? null },
        upkeep: null,
        // From the registry alone, so it is the same answer whether or not the
        // chain can be reached right now.
        timing: { deposit: depositEta(chain), withdrawal: withdrawalEta(chain) },
        active: { deposits: false, withdrawals: false, reason: 'status not read yet' },
        deposits: { supported: true },
        routes: [],
        swaps: evmSwapsView(chain.id),
      };
      // Read from Telos, so known even when the chain itself does not answer:
      // a route whose vault could not be read is still listed, with the reason.
      const listed = routesOf(ledger, String(chain.chainId), chain.vault);
      try {
        const exec = execFor(urls);
        const [head, top, upkeep, paused] = await Promise.all([
          exec.head(),
          provedTop(cfg, accounts.lightClient),
          upkeepOf(cfg, chain, accounts),
          chain.vault ? vaultPaused(exec, chain.vault) : null,
        ]);
        const routes = chain.vault ? await withOutflow(exec, chain.vault, listed) : listed;
        return {
          ...base,
          head,
          provedTop: top,
          // Null for a chain that names `settlesTo` (Polygon), as it was when
          // such chains were proved on their settlement chain's light client;
          // whether Polygon's own client is current is in `upkeep`.
          behind: top && !chain.settlesTo ? head - top.block : null,
          upkeep,
          active: activeOf(chain, routes, paused),
          routes: routes as any,
        };
      } catch (err) {
        const message = (err as Error).message;
        return { ...base, error: message, routes: listed.map((r) => ({ ...r, outflowError: message })) as any };
      }
    }),
  );

  const antelopeSources = await antelope;
  const suiSources = await Promise.all((cfg.sui ?? []).map((c) => suiStatus(cfg, ledger, c).catch((err) => ({
    id: c.chain.id,
    name: c.chain.name,
    kind: 'sui',
    error: (err as Error).message,
    routes: [],
  }))));
  const nearSources = await Promise.all((cfg.near ?? []).map((c) => nearStatus(cfg, ledger, c).catch((err) => ({
    id: c.chain.id,
    name: c.chain.name,
    kind: 'near',
    error: (err as Error).message,
    routes: [],
  }))));
  return {
    settlement: {
      id: SETTLEMENT_CHAIN,
      accounts: { ...cfg.accounts, hop: cfg.savanna.accounts.hop ?? null },
      // A hop's memo carries a swap at the far end as its third part; a swap
      // ending on Telos itself is a deposit to bridgeroute here.
      hopMemo: cfg.savanna.accounts.hop ? HOP_MEMO : null,
      swaps: antelopeSwapsView(SETTLEMENT_CHAIN),
      ...savannaState,
      note: 'one state-history stream and one finality tree serve every source chain',
    },
    sources: [...sources, ...antelopeSources, ...suiSources, ...nearSources],
  };
}

/** A packed (contract, symbol): eight bytes of name, then precision and up to seven letters. */
export function antelopeToken(extToken: string) {
  const b = Buffer.from(extToken, 'hex');
  if (b.length !== 16) return undefined;
  const contract = hexToName(extToken);
  const precision = b[8];
  let code = '';
  for (let i = 9; i < 16 && b[i]; i++) code += String.fromCharCode(b[i]);
  return { contract, symbol: code, precision };
}

/** An Antelope chain's routes as the ledger holds them, with nothing read from that chain. */
function antelopeRoutes(ledger: Ledger, domain: string) {
  const vault = antelopeVaults(ledger.routes).get(domain);
  return vault ? routesOf(ledger, domain, vault.packed) : [];
}

/**
 * What one consensus says about the two light clients of a route: whether each
 * is bootstrapped, and the upkeep that keeps them current.
 */
type LightClients = { onTelos: boolean; onFar: boolean; upkeep: Record<string, unknown> };

/**
 * A legacy chain's light clients: waxlightcl on Telos holds the chain's
 * producer keys (`core`), telosclient on the chain holds Telos's proposer
 * policy (`policy`). Both learn schedule changes from proofs.
 */
async function producerSchedules(
  cfg: IndexerConfig,
  far: AntelopeConfig,
  lcOnTelos: string | null,
  lcOnFar: string | null,
  keeper?: BlockrootKeeper,
): Promise<LightClients> {
  const chain = far.chain;
  const farRpc = { rpc: [far.rpc] };
  const [core, policy, farSchedule, telosSchedule] = await Promise.all([
    lcOnTelos ? getTableRows<any>(cfg.savanna, { code: lcOnTelos, scope: lcOnTelos, table: 'core', limit: 1 }).then((r) => r[0]) : undefined,
    lcOnFar ? getTableRows<any>(farRpc, { code: lcOnFar, scope: lcOnFar, table: 'policy', limit: 1 }).then((r) => r[0]) : undefined,
    antelopeRpc(farRpc, '/v1/chain/get_producer_schedule', {}),
    antelopeRpc(cfg.savanna, '/v1/chain/get_producer_schedule', {}),
  ]);
  const activeTelos = telosSchedule.proposed?.producers?.length ? telosSchedule.proposed : telosSchedule.pending?.producers?.length ? telosSchedule.pending : telosSchedule.active;
  return {
    onTelos: Boolean(core?.keys?.length),
    onFar: Boolean(policy?.producers?.length),
    upkeep: {
      kind: 'producer schedules',
      note: 'both light clients learn schedule changes from proofs; a lag here means the relayer has not proved the change yet',
      [`${chain.id}OnTelos`]: core ? { held: Number(core.version), active: Number(farSchedule.active.version), lag: Number(farSchedule.active.version) - Number(core.version) } : null,
      [`telosOn${capitalized(chain.id)}`]: policy ? { held: Number(policy.version), active: Number(activeTelos.version), lag: Number(activeTelos.version) - Number(policy.version) } : null,
      keeper: keeper ? keeper.snapshot() : null,
    },
  };
}

/**
 * A Savanna chain's light clients: `savannalc` on both sides, each holding the
 * one finalizer policy of the chain it follows (`policy`: generation, seats).
 * A new policy arrives with the proof of its transition block, which the
 * relayers submit before anything after it — so `active` is the newest policy
 * the chain has published, pending or in force, and a lag is a relayer behind.
 * There is no keeper: vaulta-in keeps the chain's finality tree itself.
 */
async function finalizerPolicies(
  cfg: IndexerConfig,
  far: AntelopeConfig,
  lcOnTelos: string | null,
  lcOnFar: string | null,
): Promise<LightClients> {
  const chain = far.chain;
  const farRpc = { rpc: [far.rpc] };
  const [onTelos, onFar, farInfo, telosInfo] = await Promise.all([
    lcOnTelos ? getTableRows<any>(cfg.savanna, { code: lcOnTelos, scope: lcOnTelos, table: 'policy', limit: 1 }).then((r) => r[0]) : undefined,
    lcOnFar ? getTableRows<any>(farRpc, { code: lcOnFar, scope: lcOnFar, table: 'policy', limit: 1 }).then((r) => r[0]) : undefined,
    antelopeRpc(farRpc, '/v1/chain/get_finalizer_info', {}),
    antelopeRpc(cfg.savanna, '/v1/chain/get_finalizer_info', {}),
  ]);
  const newest = (info: any) => Number((info.pending_finalizer_policy ?? info.active_finalizer_policy).generation);
  const held = (row: any, active: number) => (row ? { held: Number(row.generation), active, lag: active - Number(row.generation) } : null);
  return {
    onTelos: Boolean(onTelos?.seats?.length),
    onFar: Boolean(onFar?.seats?.length),
    upkeep: {
      kind: 'finalizer policies',
      note: 'both light clients move to a new policy with the proof of its transition block, submitted by the relayers; nothing else to keep, and a lag here means a relayer is behind',
      [`${chain.id}OnTelos`]: held(onTelos, newest(farInfo)),
      [`telosOn${capitalized(chain.id)}`]: held(onFar, newest(telosInfo)),
      keeper: null,
    },
  };
}

/** `wax` → `Wax`: `telosOnWax` as the front end has read it since the route opened; the same shape for every other chain. */
const capitalized = (id: string) => id[0].toUpperCase() + id.slice(1);

/**
 * An Antelope chain's route (WAX, XPR, Vaulta), in the shape of an EVM source
 * and with the fields only an Antelope route has. Everything is read from the
 * two chains: which vault and light clients serve it comes from the ledger's own
 * route and the gateway's and vault's `config` rows, so the endpoint follows a
 * redeployment on its own. The vault is `waxvault` on every one of them; only
 * the light clients differ with the consensus.
 *
 * Listed only for a chain this instance follows (`<PREFIX>_SHIP_URL` for a
 * legacy chain, `<PREFIX>_RPC` for a Savanna one): without that it cannot
 * answer for the chain and says nothing rather than something stale.
 */
async function antelopeStatus(cfg: IndexerConfig, ledger: Ledger, far: AntelopeConfig, keeper?: BlockrootKeeper) {
  const chain = far.chain;
  const farRpc = { rpc: [far.rpc] };
  const vault = antelopeVaults(ledger.routes).get(chain.domain);
  const base = {
    id: chain.id,
    name: chain.name,
    kind: 'antelope' as const,
    chainId: chain.chainId,
    domain: chain.domain,
    /** How its blocks are proved: producer rounds (legacy) or finality certificates (savanna). */
    strategy: chain.consensus === 'legacy' ? 'producers' : 'savanna',
    head: null as number | null,
    provedTop: null as ProvedTop,
    behind: null as number | null,
    lightClient: { account: null as string | null, contract: null as string | null },
    gateway: null as string | null,
    contracts: { vault: null as string | null, withdrawals: null as string | null, mirror: null as string | null },
    upkeep: null as Record<string, unknown> | null,
    deposits: { supported: true },
    timing: { deposit: antelopeDepositEta(chain), withdrawal: antelopeWithdrawalEta(chain) },
    active: { deposits: false, withdrawals: false, reason: `no route to ${chain.name} on the ledger` } as ChainStatus['active'],
    routes: [] as unknown[],
    /** Antelope account names: 1-12 characters of a-z, 1-5 and dots; the memo formats say the rest. */
    accountFormat: '^[a-z1-5.]{1,12}$',
    /** A crossing that ends here in a swap: bridgeroute's account and memo; null where it is not deployed. */
    swaps: antelopeSwapsView(chain.id),
  };
  if (!vault) return base;

  const gateway = String(ledger.routes.find((r) => String(r.domain) === chain.domain).gateway);
  const [gatewayCfg, vaultCfg, info] = await Promise.all([
    getTableRows<any>(cfg.savanna, { code: gateway, scope: gateway, table: 'config', limit: 1 }).then((r) => r[0]),
    getTableRows<any>(farRpc, { code: vault.account, scope: vault.account, table: 'config', limit: 1 }).then((r) => r[0]),
    antelopeRpc(farRpc, '/v1/chain/get_info', {}),
  ]);
  const lcOnTelos = gatewayCfg ? String(gatewayCfg.light_client) : null;
  const lcOnFar = vaultCfg ? String(vaultCfg.light_client) : null;
  const listed = routesOf(ledger, chain.domain, vault.packed);
  // waxlightcl and savannalc both keep their proved blocks in `blocks`, keyed
  // by number, with the `block_num`, `id` and `signers` read here.
  const [light, newest] = await Promise.all([
    chain.consensus === 'legacy'
      ? producerSchedules(cfg, far, lcOnTelos, lcOnFar, keeper)
      : finalizerPolicies(cfg, far, lcOnTelos, lcOnFar),
    lcOnTelos
      ? antelopeRpc(cfg.savanna, '/v1/chain/get_table_rows', { code: lcOnTelos, scope: lcOnTelos, table: 'blocks', reverse: true, limit: 1, json: true }).then((r: any) => r?.rows?.[0])
      : undefined,
  ]);

  const head = keeper?.state.head || Number(info.head_block_num);
  const provedTop: ProvedTop = newest
    ? { block: Number(newest.block_num), hash: String(newest.id), at: '', signers: Number(newest.signers ?? 0) }
    : null;
  // No outflow meter on the vault: what a withdrawal may take now is the
  // route's own bound, or its per-withdrawal cap where the spoke is uncapped.
  // What a deposit may still add: on the backing route, the room under the
  // Telos cap; on a spoke, the mirror coming home, which the ledger takes out
  // of `locked` and refuses beyond it — returning mirror frees the cap, it
  // never fills it.
  const routes = listed.map((r) => ({
    ...r,
    outflowPerDay: null,
    outflowLeft: null,
    withdrawableNow: withdrawableNow(r, null),
    depositableNow: r.kind === 'spoke' ? r.locked! : (BigInt(r.cap) === 0n ? null : (BigInt(r.cap) - BigInt(r.available ?? 0)).toString()),
  }));

  const reasons: string[] = [];
  const openDeposit = routes.some((r: any) => r.deposits);
  const openWithdrawal = routes.some((r: any) => r.withdrawals);
  const paused = vaultCfg ? Boolean(vaultCfg.paused) : null;
  if (!vaultCfg) reasons.push(`the ${chain.name} vault did not answer; its pause flag is unknown`);
  else if (paused) reasons.push(`the ${chain.name} vault is paused`);
  if (!light.onTelos) reasons.push(`the ${chain.name} light client on Telos is not bootstrapped`);
  else if (!openDeposit) reasons.push('no route here has deposits open');
  if (keeper && keeper.state.status !== 'following') reasons.push(`the ${chain.name} blockroot keeper is ${keeper.state.status}`);
  if (!light.onFar) reasons.push(`the Telos light client on ${chain.name} is not bootstrapped`);
  else if (!openWithdrawal) reasons.push('no route here has withdrawals open');

  return {
    ...base,
    head,
    provedTop,
    behind: provedTop ? head - provedTop.block : null,
    lightClient: { account: lcOnTelos, contract: lcOnFar },
    gateway,
    contracts: { vault: vault.account, withdrawals: vault.account, mirror: routes.find((r: any) => r.kind === 'spoke')?.antelopeToken?.contract ?? null },
    upkeep: light.upkeep,
    active: {
      deposits: paused === false && light.onTelos && openDeposit && (!keeper || keeper.state.status === 'following'),
      withdrawals: paused === false && light.onFar && openWithdrawal,
      ...(reasons.length ? { reason: reasons.join('; ') } : {}),
    },
    routes,
  };
}

/**
 * Sui: the ledger's routes to it, joined with the vault object read over
 * GraphQL. Deposits are proved by the Sui relayer; a withdrawal is released by
 * the recipient's wallet with `/v1/proofs/w:<id>` (two calls, the package and
 * objects named there). The vault's cap, daily allowance and minimum are in
 * canonical units; what it holds is raw, `scale` to a canonical unit.
 */
async function suiStatus(cfg: IndexerConfig, ledger: Ledger, sui: SuiConfig) {
  const chain = sui.chain;
  const base = {
    id: chain.id,
    name: chain.name,
    kind: 'sui' as const,
    chainId: chain.chainId,
    domain: chain.domain,
    /** Checkpoints certified by the epoch's committee, BLS min-sig, more than 2/3 of the stake. */
    strategy: 'committee',
    head: null as number | null,
    provedTop: null as ProvedTop,
    behind: null as number | null,
    lightClient: { account: null as string | null, contract: null as string | null },
    gateway: null as string | null,
    contracts: { vault: null as string | null, package: null as string | null, telosClient: null as string | null },
    upkeep: null as Record<string, unknown> | null,
    deposits: { supported: true },
    timing: { deposit: suiDepositEta(chain), withdrawal: suiWithdrawalEta(chain) },
    active: { deposits: false, withdrawals: false, reason: `no route to ${chain.name} on the ledger` } as ChainStatus['active'],
    routes: [] as unknown[],
    /** A Sui address: 0x and 64 hex digits. */
    accountFormat: '^0x[0-9a-fA-F]{64}$',
    swaps: null,
  };
  const route = ledger.routes.find((r) => String(r.domain) === chain.domain);
  if (!route) return base;

  const vaultId = '0x' + String(route.vault).toLowerCase();
  const gateway = String(route.gateway);
  const [gatewayCfg, vault, head] = await Promise.all([
    getTableRows<any>(cfg.savanna, { code: gateway, scope: gateway, table: 'config', limit: 1 }).then((r) => r[0]),
    vaultState(sui.graphql, vaultId),
    suiGraphql(sui.graphql, '{ checkpoint { sequenceNumber } }').then((d) => Number(d.checkpoint.sequenceNumber)),
  ]);
  const lightClient = gatewayCfg ? String(gatewayCfg.light_client) : null;
  const newest = lightClient
    ? (await antelopeRpc(cfg.savanna, '/v1/chain/get_table_rows', { code: lightClient, scope: lightClient, table: 'committees', reverse: true, limit: 1, json: true }))?.rows?.[0]
    : undefined;

  const now = Date.now();
  const routes = routesOf(ledger, chain.domain, vaultId).map((r) => {
    // The route's ext_token is sha256 of the coin type; `routesOf` hands it over as `token`.
    const a = vault.assets.find((x) => x.token === r.token?.replace(/^0x/, '').toLowerCase());
    if (!a) return { ...r, token: null, outflowError: 'the vault does not list this coin' };
    const left = outflowLeftNow(a, now);
    const held = a.held / a.scale;
    const room = a.cap === 0n ? null : a.cap - held;
    return {
      ...r,
      /** The Sui coin type to deposit, as a wallet takes it. */
      token: null,
      coinType: '0x' + a.coinType,
      outflowPerDay: left === null ? null : a.perPeriod.toString(),
      outflowLeft: left === null ? null : left.toString(),
      withdrawableNow: withdrawableNow(r, left),
      vaultCap: a.cap === 0n ? null : a.cap.toString(),
      vaultHeld: held.toString(),
      depositableNow: room === null ? null : (room < 0n ? 0n : room).toString(),
      vaultEnabled: a.enabled,
      vaultMinDeposit: a.minDeposit.toString(),
    };
  });
  return {
    ...base,
    head,
    /** On Sui the light client proves epochs, not blocks: the newest committee it holds. */
    provedTop: null,
    committee: newest ? { epoch: Number(newest.epoch), startMs: Number(newest.start_ms), members: (newest.stakes ?? []).length } : null,
    lightClient: { account: lightClient, contract: null },
    gateway,
    contracts: { vault: vaultId, package: vault.callPackage, telosClient: vault.telosClient },
    active: {
      deposits: !vault.depositsPaused && routes.some((r: any) => r.deposits && r.vaultEnabled),
      withdrawals: !vault.withdrawalsPaused && routes.some((r: any) => r.withdrawals),
      reason: vault.depositsPaused || vault.withdrawalsPaused
        ? `the vault is paused (deposits ${vault.depositsPaused}, withdrawals ${vault.withdrawalsPaused})`
        : 'open',
    } as ChainStatus['active'],
    routes,
  };
}

/**
 * NEAR: the ledger's routes to it, joined with the vault read through its view
 * methods. Deposits are proved by the NEAR relayer; a withdrawal is released by
 * the recipient's wallet with `/v1/proofs/w:<id>` (function calls on the vault).
 * The vault's cap, daily allowance and minimum are in canonical units; what it
 * holds is raw, `scale` to a canonical unit.
 */
async function nearStatus(cfg: IndexerConfig, ledger: Ledger, near: NearConfig) {
  const chain = near.chain;
  const base = {
    id: chain.id,
    name: chain.name,
    kind: 'near' as const,
    network: chain.network,
    chainId: chain.chainId,
    domain: chain.domain,
    /** Heads approved by more than 2/3 of the epoch's block-producer stake (ed25519). */
    strategy: 'approvals',
    head: null as number | null,
    provedTop: null as ProvedTop,
    behind: null as number | null,
    lightClient: { account: null as string | null, contract: null as string | null },
    gateway: null as string | null,
    /** The vault holds the Telos light client too: one account. */
    contracts: { vault: null as string | null, vaultAddress: null as string | null, telosClient: null as string | null },
    upkeep: null as Record<string, unknown> | null,
    deposits: { supported: true },
    timing: { deposit: nearDepositEta(chain), withdrawal: nearWithdrawalEta(chain) },
    active: { deposits: false, withdrawals: false, reason: `no route to ${chain.name} on the ledger` } as ChainStatus['active'],
    routes: [] as unknown[],
    /** A NEAR account id; on Telos it is `0x` and the 64 hex digits of its sha256. */
    accountFormat: NEAR_ACCOUNT,
    swaps: null,
  };
  const route = await nearRouteOf(cfg, chain.domain);
  if (!route) return base;

  const [vault, head, newest] = await Promise.all([
    nearVaultState(near.rpc, route.vault),
    nearRpc(near.rpc, 'block', { finality: 'final' }).then((b) => Number(b.header.height)),
    antelopeRpc(cfg.savanna, '/v1/chain/get_table_rows', {
      code: route.lightClient, scope: route.lightClient, table: 'heads', reverse: true, limit: 1, json: true,
    }).then((r) => r?.rows?.[0]),
  ]);
  const top: ProvedTop = newest
    ? { block: Number(newest.height), hash: String(newest.block_hash), at: String(newest.at), signers: Number(newest.signers) }
    : null;

  const now = Date.now();
  const routes = routesOf(ledger, chain.domain, route.address).map((r) => {
    // The route's ext_token is sha256 of the token's id; `routesOf` hands it over as `token`.
    const a = vault.assets.find((x) => x.token === r.token?.replace(/^0x/, '').toLowerCase());
    if (!a) return { ...r, token: null, outflowError: 'the vault does not list this token' };
    const left = outflowLeftNow(a, now);
    const held = a.held / a.scale;
    const room = a.cap === 0n ? null : a.cap - held;
    return {
      ...r,
      /** The NEP-141 contract to `ft_transfer_call` the vault on, or NEAR for `deposit_near`. */
      token: null,
      nearToken: a.tokenId,
      /** The recipient on Telos is the sha256 of the NEAR account id (the vault's `address_of` view computes it). */
      withdrawMemo: `${chain.domain}:0x<sha256 of the NEAR account id>`,
      outflowPerDay: left === null ? null : a.perPeriod.toString(),
      outflowLeft: left === null ? null : left.toString(),
      withdrawableNow: withdrawableNow(r, left),
      vaultCap: a.cap === 0n ? null : a.cap.toString(),
      vaultHeld: held.toString(),
      depositableNow: room === null ? null : (room < 0n ? 0n : room).toString(),
      vaultEnabled: a.enabled,
      vaultMinDeposit: a.minDeposit.toString(),
    };
  });
  return {
    ...base,
    head,
    provedTop: top,
    behind: top ? head - top.block : null,
    lightClient: { account: route.lightClient, contract: null },
    gateway: route.gateway,
    contracts: { vault: route.vault, vaultAddress: route.address, telosClient: route.vault },
    /** The Telos client inside the vault: the finalizer generation it seats. */
    telosClient: { generation: vault.client.generation, threshold: vault.client.threshold.toString() },
    active: {
      deposits: !vault.depositsPaused && routes.some((r: any) => r.deposits && r.vaultEnabled),
      withdrawals: !vault.withdrawalsPaused && routes.some((r: any) => r.withdrawals),
      reason: vault.depositsPaused || vault.withdrawalsPaused
        ? `the vault is paused (deposits ${vault.depositsPaused}, withdrawals ${vault.withdrawalsPaused})`
        : 'open',
    } as ChainStatus['active'],
    routes,
  };
}
