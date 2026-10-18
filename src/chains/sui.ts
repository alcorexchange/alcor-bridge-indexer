/**
 * Sui, the one chain the ledger reaches that is neither EVM nor Antelope.
 *
 * Deposits: a checkpoint certified by the epoch's committee (BLS min-sig, more
 * than two thirds of the stake), proved on Telos by the Sui relayer with
 * `provecp` and the gateway's `credit` — the same transaction. Withdrawals: the
 * ledger's 32/32/32 `wdlog`, folded to a Telos finality root on Sui by
 * whoever sends `release` (the user's wallet, as on the EVM routes).
 *
 * Nothing here names a deployment. The vault comes from the ledger's routes
 * (the route's `vault` is the vault object's id), and its package and Telos
 * client from the vault object itself. `SUI_GRAPHQL` turns the chain on.
 */
import { domainOf, type Span } from './antelope.ts';

export type SuiChain = {
  /** Registry id, as `/v1/chains` and `/v1/transfers` name it. */
  id: string;
  name: string;
  /** Sui's chain identifier: the genesis checkpoint digest, hex. */
  chainId: string;
  /** Its domain on the ledger: the first eight bytes of the chain identifier, big-endian. */
  domain: string;
  /** Prefix of its environment settings. */
  env: string;
  defaults: { graphql: string[] };
  deposit: { certify: Span; prove: Span };
  withdrawal: { finalize: Span; release: Span };
};

export const SUI_CHAINS: readonly SuiChain[] = [
  {
    id: 'sui',
    name: 'Sui',
    // 4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S, as `sui client chain-identifier` prints it.
    chainId: '35834a8ac17ca48fb14ac8f99c17c98747e95dd07294ae41a46b382246a4499b',
    domain: domainOf('35834a8ac17ca48fb14ac8f99c17c98747e95dd07294ae41a46b382246a4499b'),
    env: 'SUI',
    defaults: { graphql: ['https://graphql.mainnet.sui.io/graphql'] },
    // Measured on mainnet 2026-10-18: a deposit was credited on Telos within
    // seconds of its checkpoint; checkpoints certify in well under a second.
    deposit: {
      certify: { min: 1, typical: 1, max: 5 },
      prove: { min: 2, typical: 5, max: 30 },
    },
    // Telos finalizes in a second or two; the release is the user's own Sui
    // transaction (two calls), so its span is how long a wallet takes.
    withdrawal: {
      finalize: { min: 1, typical: 2, max: 5 },
      release: { min: 5, typical: 20, max: 120 },
    },
  },
];

export const suiByDomain = (domain: string | null | undefined) =>
  domain === null || domain === undefined ? undefined : SUI_CHAINS.find((c) => c.domain === String(domain));

export const suiById = (id: string | null | undefined) => SUI_CHAINS.find((c) => c.id === id);
