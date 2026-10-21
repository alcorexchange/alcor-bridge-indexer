/**
 * The one ordering of minimums a deposit address depends on: an EVM vault's
 * floor at least every other floor of the same asset.
 *
 * A deposit address forwards whatever the vault takes, and its native coin
 * cannot wait there — the clone that forwards it closes over it — so a native
 * balance at or above the vault's floor goes as one deposit. If the bridge
 * credits from more than the vault takes, or the chain it goes on to pays out
 * from more, a deposit between the two is accepted by the vault and refused
 * after it: parked on Telos, a forward that cannot complete. The deposit
 * addresses audit (C-03) settled this by keeping the floors in that order
 * rather than by code, so a floor raised on one side is a broken invariant
 * until the vault's is raised too. Read off `/v1/chains`.
 */
import { humanAmount } from './units.ts';

type Route = {
  kind?: string;
  symbol: string;
  precision: number;
  minDeposit: string;
  minWithdrawal: string;
  /** The EVM vault's own floor, canonical units; listed where the vault was read. */
  vaultMinDeposit?: string;
  /** False where the vault takes no deposits of it at all, and so has no floor to keep. */
  vaultEnabled?: boolean;
};
type Source = { id: string; name?: string; chainId?: number; error?: string; routes?: Route[] };

/** One line per floor out of order, worded for the health page. */
export function minimumAlarms(sources: Source[]): string[] {
  const alarms: string[] = [];
  const named = (s: Source) => s.name ?? s.id;
  for (const s of sources) {
    if (typeof s.chainId !== 'number') continue;
    for (const r of s.routes ?? []) {
      if (r.kind !== 'backing' || r.vaultMinDeposit === undefined || r.vaultEnabled === false) continue;
      const vaultMin = BigInt(r.vaultMinDeposit);
      const shown = (units: string | bigint) => humanAmount(units, r.precision, r.symbol);
      const head = `${r.symbol}: the ${named(s)} vault takes deposits from ${shown(vaultMin)}`;
      if (BigInt(r.minDeposit) > vaultMin) {
        alarms.push(`${head}, the bridge credits them from ${shown(r.minDeposit)}: a deposit between is refused at credit`);
      }
      for (const far of sources) {
        if (far === s) continue;
        for (const o of far.routes ?? []) {
          if (o.symbol !== r.symbol || o.precision !== r.precision || BigInt(o.minWithdrawal) <= vaultMin) continue;
          alarms.push(
            `${head}, ${named(far)} pays out from ${shown(o.minWithdrawal)}: ` +
              `a deposit address's ${r.symbol} between them cannot go on to ${named(far)}`,
          );
        }
      }
    }
  }
  return alarms;
}

/**
 * What keeps `minimumAlarms` from being an answer: a listing with no EVM chain,
 * one of `expected` missing, a chain the listing could not read or that lists
 * no routes, or an EVM backing route whose vault floor is not there. An empty
 * result means the alarms cover everything; anything else means they prove
 * nothing, and a check that must pass before a deployment fails (courier re-audit).
 */
export function unchecked(sources: Source[], expected: string[]): string[] {
  const out: string[] = [];
  const evm = sources.filter((s) => typeof s.chainId === 'number');
  if (!evm.length) out.push('no EVM chain in the listing');
  for (const id of expected) if (!evm.some((s) => s.id === id)) out.push(`${id}: not in the listing`);
  for (const s of sources) {
    if (s.error) out.push(`${s.id}: the listing could not read it (${s.error})`);
    else if (!(s.routes ?? []).length) out.push(`${s.id}: no routes listed`);
  }
  for (const s of evm) {
    for (const r of s.routes ?? []) {
      if (r.kind === 'backing' && r.vaultMinDeposit === undefined) out.push(`${s.id} ${r.symbol}: the vault's floor was not read`);
    }
  }
  return out;
}

