/**
 * Many `eth_call`s in one, through Multicall3.
 *
 * `/v1/chains` read every vault as six calls per route — the daily allowance,
 * the limit, the asset's flags, the balance, the two pause bits — and every
 * reader of it refreshed them: about fourteen billed calls per chain, every
 * fifteen seconds, whatever the traffic. Multicall3's `aggregate3` runs the same
 * reads in one call, each with its own success flag, so a read that reverts
 * fails alone instead of taking the rest with it.
 *
 * Multicall3 sits at one address on every EVM chain the bridge serves, and
 * `getEthBalance` on itself reads a native balance, so a vault's coin and its
 * tokens come back from the same call.
 */
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';

import { selector, type Exec } from './exec.ts';

export const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';

/** One read: who is called and the call data, `0x`-prefixed. */
export type Call = { to: string; data: string };

/** Reads per call: a few thousand gas each, far under the gas any node allows an `eth_call`. */
const CALLS_PER_MULTICALL = 300;

/** `getEthBalance(holder)` on Multicall3: the native balance, as a read like any other. */
export const nativeBalanceCall = (holder: string): Call => ({
  to: MULTICALL3,
  data: selector('getEthBalance(address)') + word(holder),
});

/** An address or a number as one ABI word, without `0x`. */
export function word(value: string | bigint): string {
  const hex = typeof value === 'bigint' ? value.toString(16) : value.replace(/^0x/, '').toLowerCase();
  return hex.padStart(64, '0');
}

/**
 * Each call's answer as `0x`-hex, or null where that call reverted, in the
 * order asked, as of `block` (a hex number or a tag).
 */
export async function multicall(exec: Exec, calls: Call[], block = 'latest'): Promise<(string | null)[]> {
  const out: (string | null)[] = [];
  for (let i = 0; i < calls.length; i += CALLS_PER_MULTICALL) {
    const chunk = calls.slice(i, i + CALLS_PER_MULTICALL);
    const answer: string = await exec.rpc('eth_call', [{ to: MULTICALL3, data: encodeAggregate3(chunk) }, block]);
    const results = decodeAggregate3(answer);
    // An answer of another shape is not Multicall3's: a missing contract
    // answers `0x`, and that is no reads at all rather than every read empty.
    if (results.length !== chunk.length) throw new Error(`multicall: ${results.length} answers to ${chunk.length} calls`);
    out.push(...results.map((r) => (r.success ? '0x' + bytesToHex(r.returnData) : null)));
  }
  return out;
}

/**
 * `aggregate3((address,bool,bytes)[])` with every call allowed to fail.
 *
 * The array is dynamic and so is each element: the head holds the array's
 * offset, the array its length and one offset per element (from the start of
 * the offsets), each element its target, its flag, and its bytes' offset (from
 * the element) followed by the bytes, padded to a word.
 */
export function encodeAggregate3(calls: Call[]): string {
  const elements = calls.map(({ to, data }) => {
    const bytes = data.replace(/^0x/, '').toLowerCase();
    const padded = bytes.padEnd(Math.ceil(bytes.length / 64) * 64, '0');
    return word(to) + word(1n) + word(0x60n) + word(BigInt(bytes.length / 2)) + padded;
  });
  let offset = 32n * BigInt(calls.length);
  const offsets = elements.map((e) => {
    const at = word(offset);
    offset += BigInt(e.length / 2);
    return at;
  });
  return selector('aggregate3((address,bool,bytes)[])') + word(0x20n) + word(BigInt(calls.length)) + offsets.join('') + elements.join('');
}

/** `aggregate3`'s answer, `(bool success, bytes returnData)[]`, laid out as above. */
export function decodeAggregate3(answer: string): { success: boolean; returnData: Uint8Array }[] {
  const b = hexToBytes(answer.replace(/^0x/, ''));
  if (b.length < 64) return [];
  const at = (i: number) => Number(BigInt('0x' + bytesToHex(b.slice(i, i + 32))));
  const arrayAt = at(0);
  const count = at(arrayAt);
  const offsetsAt = arrayAt + 32;
  return Array.from({ length: count }, (_, i) => {
    const elementAt = offsetsAt + at(offsetsAt + 32 * i);
    const bytesAt = elementAt + at(elementAt + 32);
    const length = at(bytesAt);
    return { success: at(elementAt) === 1, returnData: b.slice(bytesAt + 32, bytesAt + 32 + length) };
  });
}
