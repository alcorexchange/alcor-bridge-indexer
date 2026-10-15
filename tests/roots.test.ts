/**
 * Resolving which settlement block a trusted root was taken as of, against a
 * node served from memory: the slot names the carrier, and the carrier's
 * certificate names the block the root belongs to.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { resolveRootBlocks, blockAtSlot } from '../services/indexer/roots.ts';
import { Store } from '../services/indexer/db.ts';
import { slotToTimestamp } from '../src/proof/pack.ts';
import type { SavannaChain } from '../src/chains/savanna.ts';

const EPOCH = { blockTimestampEpochMs: 946_684_800_000, blockIntervalMs: 500 };
const HEAD = 10_000;
/** Block n is at slot n + 5000, except that slot 5000 + 4000 was missed. */
const slotOf = (n: number) => n + 5_000 + (n >= 4_000 ? 1 : 0);

test('roots without a block get the block their carrier claims; one with no carrier waits', async () => {
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      res.setHeader('content-type', 'application/json');
      if (req.url === '/v1/chain/get_info') {
        res.end(JSON.stringify({ head_block_num: HEAD, head_block_time: slotToTimestamp(EPOCH, slotOf(HEAD)) }));
        return;
      }
      const n = Number(body.block_num_or_id);
      // Every block claims its predecessor, except 6000, which claims 5998.
      const claimed = n === 6_000 ? 5_998 : n - 1;
      res.end(JSON.stringify({
        block_num: n,
        timestamp: slotToTimestamp(EPOCH, slotOf(n)),
        finality_extension: { qc_claim: { block_num: claimed } },
      }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const chain = { ...EPOCH, rpc: [`http://127.0.0.1:${port}`], finalityGenesisBlock: 1 } as unknown as SavannaChain;

  try {
    assert.equal(await blockAtSlot(chain, slotOf(4_500)), 4_500);
    assert.equal(await blockAtSlot(chain, 9_000), undefined); // the missed slot

    const store = new Store(':memory:');
    store.putRoot('0xaa', slotOf(3_000), null, 1, 1);
    store.putRoot('0xbb', slotOf(6_000), null, 2, 56);
    store.putRoot('0xcc', 9_000, null, 3, 1);
    assert.equal(await resolveRootBlocks(store, chain), 2);
    assert.deepEqual({ ...store.earliestRootCovering(0, 1) }, { mroot: '0xaa', block: 2_999 });
    assert.deepEqual({ ...store.earliestRootCovering(0, 56) }, { mroot: '0xbb', block: 5_998 });
    assert.deepEqual(store.rootsWithoutBlock().map((r) => r.mroot), ['0xcc']);
  } finally {
    server.close();
  }
});
