/**
 * An amount a person can read.
 *
 * `amount` is canonical units, an integer; the listing says how many decimals
 * the symbol carries. `20 WAX`, `0.001 ETH`, `5 USDC` — trailing zeros dropped,
 * so that a UI which just wants the string has it and one that wants to format
 * its own way still has `amount` and `precision`.
 */
export function humanAmount(amount: string | bigint, precision: number, symbol: string): string {
  return `${decimalAmount(amount, precision)} ${symbol}`;
}

/** The number alone, as a decimal string: `2259.027309`, `-0.5`, `20`. Never a float. */
export function decimalAmount(amount: string | bigint, precision: number): string {
  const units = BigInt(amount);
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const scale = 10n ** BigInt(precision);
  const whole = abs / scale;
  const fraction = (abs % scale).toString().padStart(precision, '0').replace(/0+$/, '');
  const number = fraction ? `${whole}.${fraction}` : whole.toString();
  return `${negative ? '-' : ''}${number}`;
}

/** `decimalAmount` read back: `2259.027309` at precision 6 is 2259027309n. */
export function decimalUnits(amount: string, precision: number): bigint {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(amount);
  if (!match || (match[3]?.length ?? 0) > precision) {
    throw new Error(`${amount} is not a decimal with at most ${precision} places`);
  }
  const [, sign, whole, fraction = ''] = match;
  const units = BigInt(whole + fraction.padEnd(precision, '0'));
  return sign ? -units : units;
}

/** An Antelope asset as a table prints it, `0.01000000 ETH`: its integer units, symbol and precision. */
export function parseAsset(text: string): { units: bigint; symbol: string; precision: number } {
  const [amount, symbol] = text.split(' ');
  const dot = amount.indexOf('.');
  const precision = dot < 0 ? 0 : amount.length - dot - 1;
  return { units: decimalUnits(amount, precision), symbol, precision };
}
