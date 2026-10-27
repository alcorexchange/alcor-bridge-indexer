import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Exec } from '../src/evm/exec.ts';
import { MULTICALL3, decodeAggregate3, encodeAggregate3, multicall, nativeBalanceCall, word } from '../src/evm/multicall.ts';

const VAULT = '0x3e447d533321ad6a8412f97034ac295a9ff8d858';

test('aggregate3 is encoded the way a full ABI encoder writes it', () => {
  // From src/evm/abi.ts encodeCall('aggregate3((address,bool,bytes)[])', ...) in the
  // main repository, for a four-byte call and an empty one.
  const data = encodeAggregate3([
    { to: VAULT, data: '0x5c975abb' },
    { to: MULTICALL3, data: '0x' },
  ]);
  assert.equal(
    data,
    '0x82ad56cb' +
      word(0x20n) + word(2n) + word(0x40n) + word(0xe0n) +
      word(VAULT) + word(1n) + word(0x60n) + word(4n) + '5c975abb'.padEnd(64, '0') +
      word(MULTICALL3) + word(1n) + word(0x60n) + word(0n),
  );
});

/** An `aggregate3` answer: each result's flag and bytes. */
function answer(results: { success: boolean; data: string }[]): string {
  const elements = results.map(({ success, data }) => {
    const bytes = data.replace(/^0x/, '');
    return word(success ? 1n : 0n) + word(0x40n) + word(BigInt(bytes.length / 2)) + bytes.padEnd(Math.ceil(bytes.length / 64) * 64, '0');
  });
  let offset = 32 * results.length;
  const offsets = elements.map((e) => { const at = word(BigInt(offset)); offset += e.length / 2; return at; });
  return '0x' + word(0x20n) + word(BigInt(results.length)) + offsets.join('') + elements.join('');
}

const execAnswering = (reply: (data: string) => string, seen: unknown[][] = []): Exec => ({
  urls: [],
  rpc: async (method, params) => { seen.push([method, params]); return reply((params[0] as { data: string }).data); },
  head: async () => 0,
  logs: async () => [],
});

test('each read keeps its own success: a revert is null, not a failed batch', async () => {
  const seen: unknown[][] = [];
  const exec = execAnswering(() => answer([{ success: true, data: word(7n) }, { success: false, data: '0x' }]), seen);
  assert.deepEqual(await multicall(exec, [{ to: VAULT, data: '0x01' }, nativeBalanceCall(VAULT)]), ['0x' + word(7n), null]);
  assert.equal(seen.length, 1);
  assert.equal(((seen[0][1] as any[])[0] as { to: string }).to, MULTICALL3);
});

test('an answer that is not Multicall3\'s fails the whole read', async () => {
  await assert.rejects(multicall(execAnswering(() => '0x'), [{ to: VAULT, data: '0x01' }]), /0 answers to 1 calls/);
  await assert.rejects(multicall(execAnswering(() => answer([])), [{ to: VAULT, data: '0x01' }]), /0 answers to 1 calls/);
});

test('decoding reads back what was answered', () => {
  const [a, b] = decodeAggregate3(answer([{ success: true, data: '0xdeadbeef' }, { success: false, data: '0x' }]));
  assert.equal(a.success, true);
  assert.deepEqual([...a.returnData], [0xde, 0xad, 0xbe, 0xef]);
  assert.equal(b.success, false);
  assert.equal(b.returnData.length, 0);
});
