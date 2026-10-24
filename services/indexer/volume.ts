/**
 * How much crosses the bridge, and how many people cross it.
 *
 * For the operator first: the vault's daily outflow limit and the route caps
 * were set from a guess, and this is what replaces the guess — per asset and
 * direction, the volume over a day, a week, a month and all time, its average
 * per day, and the busiest day. A limit well above the busiest day is slack; a
 * limit at it is the next complaint.
 *
 * People are counted twice over, because a crossing has two ends: `accounts`
 * are the Telos accounts, `addresses` the far side's — an EVM address or an
 * Antelope account. Amounts are never added across tokens; the totals are counts.
 */
import { humanAmount } from '../../src/units.ts';
import { DAY, PERIODS } from './activity.ts';
import type { Direction, Store, VolumeRow } from './db.ts';

/** What an asset is called, for a (domain, token) pair the store groups by. */
export type Describe = (domain: string | null, token: string | null) => {
  chain: string | null;
  symbol: string | null;
  precision: number | null;
};

export type AssetVolume = {
  direction: Direction;
  chain: string | null;
  symbol: string | null;
  token: string | null;
  count: number;
  /** Canonical units, like a transfer's `amount`. */
  amount: string;
  amountHuman: string | null;
  accounts: number;
  addresses: number;
};

export type WindowVolume = {
  since: number;
  days: number;
  people: ReturnType<Store['people']>;
  assets: (AssetVolume & {
    perDay: string;
    perDayHuman: string | null;
    peakDay: { day: string; amount: string; amountHuman: string | null } | null;
  })[];
};

const assetKey = (r: VolumeRow) => `${r.direction}|${r.domain}|${r.token}`;

function described(r: VolumeRow, describe: Describe, amount: bigint = BigInt(r.amount ?? 0)): AssetVolume {
  const { chain, symbol, precision } = describe(r.domain, r.token);
  return {
    direction: r.direction,
    chain,
    symbol,
    token: r.token,
    count: r.count,
    amount: amount.toString(),
    amountHuman: human(amount, precision, symbol),
    accounts: r.accounts,
    addresses: r.addresses,
  };
}

function human(amount: bigint, precision: number | null, symbol: string | null): string | null {
  return precision === null || symbol === null ? null : humanAmount(amount, precision, symbol);
}

/**
 * The whole report. `daily` is the last `days` calendar days (UTC) that saw a
 * crossing, oldest first; a day with none has no rows.
 */
export function volume(store: Store, describe: Describe, now: number, days: number) {
  const daily = store.volume(0, true);
  const firstDay = daily[0]?.day ? Date.parse(`${daily[0].day}T00:00:00Z`) / 1000 : now;

  const windows: Record<string, WindowVolume> = {};
  // The activity summary's windows; here `all` starts at the first crossing.
  for (const [name, span] of Object.entries(PERIODS)) {
    const since = span === null ? 0 : now - span;
    const length = span === null ? Math.max(1, Math.ceil((now - firstDay) / DAY)) : span / DAY;
    const sinceDay = new Date(since * 1000).toISOString().slice(0, 10);
    windows[name] = {
      since,
      days: length,
      people: store.people(since),
      assets: store.volume(since, false).map((r) => {
        const a = described(r, describe);
        const { precision } = describe(r.domain, r.token);
        const perDay = BigInt(a.amount) / BigInt(length);
        const peak = daily
          .filter((d) => assetKey(d) === assetKey(r) && d.day !== null && d.day >= sinceDay)
          .reduce<VolumeRow | null>((best, d) => (!best || BigInt(d.amount ?? 0) > BigInt(best.amount ?? 0) ? d : best), null);
        return {
          ...a,
          perDay: perDay.toString(),
          perDayHuman: human(perDay, precision, a.symbol),
          peakDay: peak
            ? { day: peak.day!, amount: String(peak.amount ?? 0), amountHuman: human(BigInt(peak.amount ?? 0), precision, a.symbol) }
            : null,
        };
      }),
    };
  }

  const fromDay = new Date((now - (days - 1) * DAY) * 1000).toISOString().slice(0, 10);
  return {
    asOf: now,
    windows,
    daily: daily.filter((d) => d.day !== null && d.day >= fromDay).map((d) => ({ day: d.day!, ...described(d, describe) })),
  };
}
