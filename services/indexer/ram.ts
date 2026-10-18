/**
 * RAM left to the accounts that pay for the bridge's own rows.
 *
 * The ledger bills every withdrawal, every replay record and every parked
 * deposit to itself, and keeps the withdrawals for good; the hop keeps a row per
 * hop; each Antelope chain's vault pays for every new holder a release creates. None of that is
 * a cost worth metering, but running out of it stops the bridge whole: every
 * credit and every withdrawal on every route fails until someone buys more. On
 * 2026-10-03 the ledger had 195 KB left, about 350 parked deposits of 1 WAX.
 * This is what says so before it happens.
 */

import { antelopeRpc, getTableRows } from '../../src/net/antelope.ts';
import { antelopeVaults } from '../../src/chains/antelope.ts';
import { ANTELOPE_SWAPS } from '../../src/chains/swaps.ts';
import { SETTLEMENT_CHAIN, type IndexerConfig } from './config.ts';

/** `chain` is `telos` or an Antelope registry id: `wax`, `xpr`, `vaulta`. `alarmAt` is the bar it is held to. */
export type RamRow = { chain: string; account: string; used: number; quota: number; free: number; alarmAt: number };

/**
 * Below this many free bytes an account is an alarm: a few thousand rows, a day
 * of an attack or a long while of honest use. `RAM_ALARM_BYTES` overrides it.
 */
export const RAM_ALARM_BYTES = Number(process.env.RAM_ALARM_BYTES ?? 500_000);

/**
 * bridgeroute's bar: its orders are erased as they end, so what it spends for
 * good is the balance row it opens for each recipient new to a token, about
 * 240 bytes. Out of RAM, the bridge's payouts to it fail and go back home.
 * It is deployed with 64 KB to spare; this is about a hundred and thirty rows.
 */
export const ROUTE_RAM_ALARM_BYTES = Number(process.env.ROUTE_RAM_ALARM_BYTES ?? 32_000);

/**
 * A relayer's bar. Every block it proves to a light client is a row of a few
 * hundred bytes billed to it, and only the client's owner can prune them. Out
 * of RAM, its chain's crossings stop: withdrawals to XPR sat ten hours on
 * 2026-10-18 behind a relayer 188 bytes short. At a handful of proofs a day,
 * this is a few weeks' warning.
 */
export const RELAYER_RAM_ALARM_BYTES = Number(process.env.RELAYER_RAM_ALARM_BYTES ?? 32_000);

/**
 * The relayers' own accounts, as `<chain>:<account>` pairs separated by commas:
 * `telos:payer,xpr:relayer`. Configured rather than read from a chain,
 * because nothing on chain says who relays.
 */
export function parseRelayerAccounts(raw: string): { chain: string; account: string }[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((pair) => {
      const [chain, account] = pair.split(':').map((s) => s.trim());
      if (!chain || !account) throw new Error(`RELAYER_RAM_ACCOUNTS: "${pair}" is not <chain>:<account>`);
      return { chain, account };
    });
}

async function ramOf(rpc: { rpc: string[] }, chain: string, account: string, alarmAt = RAM_ALARM_BYTES): Promise<RamRow> {
  const a = await antelopeRpc(rpc, '/v1/chain/get_account', { account_name: account });
  const used = Number(a.ram_usage);
  const quota = Number(a.ram_quota);
  return { chain, account, used, quota, free: quota - used, alarmAt };
}

/**
 * The ledger and the hop on Telos, the vault on each Antelope chain this
 * instance reads, bridgeroute wherever it is deployed, and the relayers in
 * `RELAYER_RAM_ACCOUNTS`. A vault's account is the one the ledger's routes to
 * that chain name, so it is never configured twice.
 */
export async function ramReport(cfg: IndexerConfig): Promise<RamRow[]> {
  const telos = [cfg.accounts.bridge, cfg.savanna.accounts.hop].filter((a): a is string => !!a);
  const reads = telos.map((account) => ramOf(cfg.savanna, 'telos', account));
  const telosRoute = ANTELOPE_SWAPS[SETTLEMENT_CHAIN]?.route;
  if (telosRoute) reads.push(ramOf(cfg.savanna, 'telos', telosRoute, ROUTE_RAM_ALARM_BYTES));
  for (const a of cfg.antelope) {
    const route = ANTELOPE_SWAPS[a.chain.id]?.route;
    if (route) reads.push(ramOf({ rpc: [a.rpc] }, a.chain.id, route, ROUTE_RAM_ALARM_BYTES));
  }

  if (cfg.antelope.length) {
    const routes = await getTableRows<any>(cfg.savanna, {
      code: cfg.accounts.bridge,
      scope: cfg.accounts.bridge,
      table: 'routes',
      limit: 200,
    });
    const vaults = antelopeVaults(routes);
    for (const a of cfg.antelope) {
      const vault = vaults.get(a.chain.domain);
      if (vault) reads.push(ramOf({ rpc: [a.rpc] }, a.chain.id, vault.account));
    }
  }

  for (const r of parseRelayerAccounts(process.env.RELAYER_RAM_ACCOUNTS ?? '')) {
    const far = cfg.antelope.find((a) => a.chain.id === r.chain);
    if (r.chain !== SETTLEMENT_CHAIN && !far) throw new Error(`RELAYER_RAM_ACCOUNTS: this instance reads no chain "${r.chain}"`);
    reads.push(ramOf(far ? { rpc: [far.rpc] } : cfg.savanna, r.chain, r.account, RELAYER_RAM_ALARM_BYTES));
  }
  return Promise.all(reads);
}

/** One line per account below the bar, for the health page's alarms. */
export function ramAlarms(rows: RamRow[]): string[] {
  return rows
    .filter((r) => r.free < r.alarmAt)
    .map((r) => `${r.account} on ${r.chain} has ${Math.round(r.free / 1024)} KB of RAM left — buy more before credits and withdrawals start failing`);
}
