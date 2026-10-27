/**
 * The execution-layer pool: calls take the endpoints in turn instead of always
 * starting at the first, and a method-specific refusal (403) parks an endpoint
 * for that method only, while a rate limit (429) parks it for everything.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { execRpc, execLogs } from '../src/evm/exec.ts';

/** `fetch` answering per host and method; records the host of every request. */
function hosts(t: any, seen: string[], refuse: (host: string, method: string) => number | undefined = () => undefined) {
  t.mock.method(globalThis, 'fetch', async (url: string, init: any) => {
    const host = new URL(String(url)).hostname;
    const { id, method } = JSON.parse(init.body);
    seen.push(host);
    const status = refuse(host, method);
    if (status) return new Response('refused', { status });
    return Response.json({ jsonrpc: '2.0', id, result: method === 'eth_getLogs' ? [] : '0x1' });
  });
}

test('calls start at the next endpoint each time', async (t) => {
  const seen: string[] = [];
  hosts(t, seen);
  const urls = ['https://a.turn.test', 'https://b.turn.test', 'https://c.turn.test'];
  for (let i = 0; i < 3; i++) await execRpc('eth_getTransactionReceipt', ['0x1'], urls);
  assert.deepEqual(seen, ['a.turn.test', 'b.turn.test', 'c.turn.test']);
});

test('a 403 on one method parks the endpoint for that method only', async (t) => {
  const seen: string[] = [];
  hosts(t, seen, (host, method) => (host === 'archive.park.test' && method === 'eth_getBlockReceipts' ? 403 : undefined));
  const urls = ['https://archive.park.test', 'https://ok.park.test'];

  await execRpc('eth_getBlockReceipts', ['0x1'], urls);
  assert.deepEqual(seen, ['archive.park.test', 'ok.park.test'], 'refused, then the next endpoint answered');

  seen.length = 0;
  for (let i = 0; i < 2; i++) await execRpc('eth_getBlockReceipts', ['0x1'], urls);
  assert.deepEqual(seen, ['ok.park.test', 'ok.park.test'], 'the refusing endpoint is not asked that method again');

  seen.length = 0;
  for (let i = 0; i < 2; i++) await execLogs({}, {}, urls);
  assert.ok(seen.includes('archive.park.test'), 'logs still go to it');
});

test('a 429 parks the endpoint for every method', async (t) => {
  const seen: string[] = [];
  hosts(t, seen, (host) => (host === 'limited.rate.test' ? 429 : undefined));
  const urls = ['https://limited.rate.test', 'https://ok.rate.test'];

  await execRpc('eth_call', [{}], urls);
  seen.length = 0;
  await execRpc('eth_getTransactionReceipt', ['0x1'], urls);
  await execLogs({}, {}, urls);
  assert.deepEqual(seen, ['ok.rate.test', 'ok.rate.test']);
});
