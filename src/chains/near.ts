/**
 * NEAR, a chain the ledger reaches that is neither EVM nor Antelope (docs/NEAR.md
 * in the bridge repository).
 *
 * Deposits: a log line of the vault (`alcor:deposit:`) in a receipt outcome,
 * proved on Telos by the NEAR relayer against a head `nearlightcl` accepted —
 * more than two thirds of the epoch's block-producer stake approved it. Withdrawals:
 * the ledger's 32/32/32 `wdlog`, folded to a Telos finality root by the vault's
 * own Telos client, released by whoever sends `release` (the user's wallet).
 *
 * Every NEAR account is sha256 of its account id on Telos: the vault, each token
 * (`NEAR` for native NEAR), each recipient. Nothing here names a deployment: the
 * vault's account id is the one the route's gateway on Telos holds, checked to
 * hash to the route's vault. `NEAR_RPC` (or `NEAR_TESTNET_RPC`) turns a chain on.
 */
import { domainOf, type Span } from './antelope.ts';

export type NearChain = {
  /** Registry id, as `/v1/chains` and `/v1/transfers` name it. */
  id: string;
  name: string;
  network: 'mainnet' | 'testnet';
  /** The genesis hash, hex (base58 in NEAR's own tools). */
  chainId: string;
  /** Its domain on the ledger: the first eight bytes of the genesis hash, big-endian. */
  domain: string;
  /** Prefix of its environment settings. */
  env: string;
  defaults: { rpc: string[]; txApi: string };
  deposit: { final: Span; prove: Span };
  withdrawal: { finalize: Span; release: Span };
};

/** A deposit is final in two blocks (~1.2 s); the relayer then submits a head and the proof. */
const deposit = { final: { min: 1, typical: 2, max: 5 }, prove: { min: 3, typical: 6, max: 30 } };
/** Telos finalizes in a second or two; the release is the wallet's own NEAR transactions. */
const withdrawal = { finalize: { min: 1, typical: 2, max: 5 }, release: { min: 5, typical: 20, max: 120 } };

export const NEAR_CHAINS: readonly NearChain[] = [
  {
    id: 'near',
    name: 'NEAR',
    network: 'mainnet',
    // EPnLgE7iEq9s7yTkos96M3cWymH5avBAPm3qx3NXqR8H, as the `status` RPC prints it.
    chainId: 'c6fdf91c8e82f8f917cc1975e9de1c64be11899e321dfdf5febcfbb7313f1486',
    domain: domainOf('c6fdf91c8e82f8f917cc1975e9de1c64be11899e321dfdf5febcfbb7313f1486'),
    env: 'NEAR',
    defaults: { rpc: ['https://rpc.mainnet.fastnear.com'], txApi: 'https://tx.main.fastnear.com' },
    deposit,
    withdrawal,
  },
  {
    id: 'near-testnet',
    name: 'NEAR testnet',
    network: 'testnet',
    // FWJ9kR6KFWoyMoNjpLXXGHeuiy7tEY6GmoFeCA5yuc6b
    chainId: 'd784da5a9e5e66668516c19a8095448fc54a22a28971dc330f0099df94379410',
    domain: domainOf('d784da5a9e5e66668516c19a8095448fc54a22a28971dc330f0099df94379410'),
    env: 'NEAR_TESTNET',
    defaults: { rpc: ['https://rpc.testnet.fastnear.com'], txApi: 'https://tx.test.fastnear.com' },
    deposit,
    withdrawal,
  },
];

export const nearByDomain = (domain: string | null | undefined) =>
  domain === null || domain === undefined ? undefined : NEAR_CHAINS.find((c) => c.domain === String(domain));

export const nearById = (id: string | null | undefined) => NEAR_CHAINS.find((c) => c.id === id);

/** A NEAR account id: 2 to 64 characters, lowercase parts joined by dots (nearcore's rule). */
export const NEAR_ACCOUNT = '^(?=.{2,64}$)(([a-z\\d]+[-_])*[a-z\\d]+\\.)*([a-z\\d]+[-_])*[a-z\\d]+$';
