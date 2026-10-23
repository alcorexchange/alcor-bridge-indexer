/**
 * The Antelope chains the ledger reaches besides Telos, in two kinds.
 *
 * - `legacy`: DPoS without finality certificates (WAX, XPR), proved on Telos by
 *   two rounds of producer signatures (waxlightcl) and proving Telos to
 *   themselves the same way (telosclient). They share every contract, relayer
 *   and keeper, and each needs a blockroot keeper: what its producers sign over
 *   is in no header.
 * - `savanna`: BLS finality (Vaulta), proved both ways by `savannalc`, the same
 *   contract on each side. Nothing to keep: its relayers prove everything,
 *   vaulta-in growing the chain's finality tree itself.
 *
 * The vault is `waxvault` on both kinds, so its tables, its `deplog` and the
 * relayers' crossings files read the same everywhere; what differs is here.
 *
 * Each chain's settings are read from the environment under its prefix:
 * `<PREFIX>_SHIP_URL` turns a legacy chain on (its keeper streams it),
 * `<PREFIX>_RPC` a Savanna one. Either way the indexer needs both: the socket
 * is where its own history of the chain comes from. For a legacy chain
 * `<PREFIX>_RPC`, `<PREFIX>_BLOCKROOT_SEED` and `<PREFIX>_DIR` override the defaults.
 */
/** A duration that is not one number, because none of these are. Seconds. */
import { hexToName } from '../proof/pack.ts';

export type Span = { min: number; typical: number; max: number };

type Common = {
  /** Registry id, as `/v1/chains` and `/v1/transfers` name it. */
  id: string;
  name: string;
  chainId: string;
  /**
   * Its domain on the ledger: the first eight bytes of the chain id, big-endian.
   * A string, always: Vaulta's is twenty digits, past both int64 and 2^53.
   */
  domain: string;
  /** Prefix of its environment settings. */
  env: string;
};

export type LegacyChain = Common & {
  consensus: 'legacy';
  defaults: { rpc: string; seedFile: string };
  /** How long its producers take to build two rounds of 2/3+1 on a block. */
  confirm: Span;
};

export type SavannaSource = Common & {
  consensus: 'savanna';
  /**
   * A public endpoint, for a reader that does not run the chain (the courier).
   * Not the indexer's default: giving `<PREFIX>_RPC` is what turns the chain on there.
   */
  defaults: { rpc: string };
  /** Deposits: its finalizers certifying the block, then the relayer proving it on Telos. */
  deposit: { certify: Span; prove: Span };
  /** Withdrawals: Telos finalizing the burn, then the relayer releasing it here. */
  withdrawal: { finalize: Span; release: Span };
};

export type AntelopeChain = LegacyChain | SavannaSource;

/** A chain's domain on the ledger: the first eight bytes of its chain id, big-endian, as a decimal string. */
export const domainOf = (chainId: string): string => BigInt('0x' + chainId.slice(0, 16)).toString();

function chain<C extends AntelopeChain>(c: Omit<C, 'domain'>): C {
  return { ...c, domain: domainOf(c.chainId) } as C;
}

export const ANTELOPE_CHAINS: readonly AntelopeChain[] = [
  chain<LegacyChain>({
    id: 'wax',
    name: 'WAX',
    chainId: '1064487b3cd1a897ce03ae5b6a865651747e2e152090f99c1d19d44e01aea5a4',
    env: 'WAX',
    consensus: 'legacy',
    defaults: { rpc: 'https://wax.eosusa.io', seedFile: 'data/wax-blockroot-seed.json' },
    // 8 producers, 6 needed per round; measured on mainnet 2026-09-30.
    confirm: { min: 36, typical: 42, max: 72 },
  }),
  chain<LegacyChain>({
    id: 'xpr',
    name: 'XPR Network',
    chainId: '384da888112027f0321850a169f737c33e53b388aad48b5adace4bab97f437e0',
    env: 'XPR',
    consensus: 'legacy',
    defaults: { rpc: 'https://proton.eosusa.io', seedFile: 'data/xpr-blockroot-seed.json' },
    // 21 producers, 15 needed per round, six seconds each: fourteen turns a round.
    confirm: { min: 160, typical: 170, max: 230 },
  }),
  chain<SavannaSource>({
    id: 'vaulta',
    name: 'Vaulta',
    chainId: 'aca376f206b8fc25a6ed44dbdc66547c36c6c33e3a119ffbeaef943642f0e906',
    env: 'VAULTA',
    consensus: 'savanna',
    defaults: { rpc: 'https://eos.eosusa.io' },
    // An estimate pending a production measurement. Savanna finalizes in a
    // second or two on both chains; the rest is the relayers: vaulta-in proves
    // a log once its stream holds a root covering it, vaulta-out streams
    // irreversible Telos blocks and waits for the indexer's tree to reach the
    // root it releases against. A staging round trip took tens of seconds.
    deposit: {
      certify: { min: 1, typical: 2, max: 5 },
      prove: { min: 2, typical: 5, max: 30 },
    },
    withdrawal: {
      finalize: { min: 1, typical: 2, max: 5 },
      release: { min: 3, typical: 10, max: 40 },
    },
  }),
];

/** The variable whose presence turns a chain on in this instance (see above). */
export const enabledBy = (c: AntelopeChain) => (c.consensus === 'legacy' ? `${c.env}_SHIP_URL` : `${c.env}_RPC`);

export const antelopeByDomain = (domain: string | null | undefined) =>
  domain === null || domain === undefined ? undefined : ANTELOPE_CHAINS.find((c) => c.domain === String(domain));

export const antelopeById = (id: string | null | undefined) => ANTELOPE_CHAINS.find((c) => c.id === id);

/** The relayers' crossings files for a chain, under the shared relayer directory. */
export const crossingsFiles = (c: AntelopeChain) => [`${c.id}-in`, `${c.id}-out`];

/** An Antelope chain's vault: its account, and the eight bytes the ledger's routes name it by. */
export type AntelopeVault = { account: string; packed: string };

/**
 * The vault each Antelope domain's routes name, from the ledger's `routes`. An
 * Antelope vault is a packed name, eight bytes, where an EVM one is twenty; the
 * vault is never configured, so a redeployment is followed from the ledger.
 */
export function antelopeVaults(routes: { domain: unknown; vault: unknown }[]): Map<string, AntelopeVault> {
  const out = new Map<string, AntelopeVault>();
  for (const r of routes) {
    const packed = String(r.vault);
    if (packed.length === 16 && !out.has(String(r.domain))) {
      out.set(String(r.domain), { account: hexToName(packed), packed });
    }
  }
  return out;
}
