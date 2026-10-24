/**
 * Run the indexer's EVM half against BSC once, and show what it made of it.
 *
 * The Savanna half needs a state-history socket; this does not, so the Parlia
 * deposit path can be exercised on its own — scan a block range, notice a
 * whitelisted log, freeze it into an artifact, and store it. Which is the whole
 * new code path, end to end, against a real deposit.
 *
 *   CHAIN=bsc node scripts/bsc-indexer-check.ts <fromBlock> [toBlock]
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadConfig } from '../services/indexer/config.ts';
import { Store } from '../services/indexer/db.ts';
import { EvmFollower } from '../services/indexer/evm.ts';
import { epochBacklog } from '../src/bsc/parlia.ts';
import { execHead } from '../src/evm/exec.ts';

const from = Number(process.argv[2]);
if (!from) throw new Error('usage: bsc-indexer-check.ts <fromBlock> [toBlock]');

// The Savanna follower is not started here, but `loadConfig` insists on a socket
// for it — so name one and leave it unused rather than loosening the check.
process.env.SHIP_URL ??= 'ws://127.0.0.1:3335';
// A caller-supplied directory wins: the frozen payloads are the point of running
// this, and a temp dir that changes every run makes them hard to push.
process.env.DATA_DIR ??= mkdtempSync(join(tmpdir(), 'bsc-indexer-'));

const cfg = loadConfig();
const store = new Store(cfg.dbFile);
const source = cfg.sources.find((s) => s.chain.id === (process.env.CHAIN ?? cfg.evm.id));
if (!source) throw new Error(`no source chain for CHAIN=${process.env.CHAIN}`);
const evm = new EvmFollower(cfg, store, source);

console.log(`instance ${cfg.instance}`);
console.log(`  evm        ${cfg.evm.id} (${cfg.evm.strategy}), epoch ${cfg.evm.epochLength}`);
console.log(`  accounts   ${cfg.accounts.lightClient} / ${cfg.accounts.gateway} -> ${cfg.accounts.bridge}`);
console.log(`  vault      ${cfg.evm.vault}`);

const wiring = await evm.verifyWiring();
console.log(`  wiring     ${wiring.length ? wiring.join('; ') : 'as configured'}`);

const backlog = await epochBacklog(cfg);
console.log(`  epochs     ${backlog ? `stored ${backlog.stored}, chain ${backlog.head}, lag ${backlog.lag}` : 'unknown'}`);

const head = await execHead();
const to = Number(process.argv[3] ?? Math.min(from + 200, head));
console.log(`\nscanning ${from}..${to} (head ${head})`);

// `tick` is private and stays that way: this is a harness, not a second entry
// point into the follower.
const inner = evm as any;
inner.state.at = from - 1;
inner.state.head = head;
await inner.scan(from, to);
await inner.freezeMatured();

const transfers = store.listTransfers ? store.listTransfers({}) : [];
console.log(`\ntransfers: ${transfers.length}`);
for (const t of transfers) console.log(`  ${t.key}  ${t.direction}  ${t.status}  block ${t.src_block}`);

// A withdrawal's own key carries no proof; the `Voided` log that refunds it is
// filed under `v:<id>`, so both are looked for.
const keys = transfers.flatMap((t: any) =>
  t.direction === 'withdrawal' ? [t.key, `v:${t.ref}`] : [t.key],
);

for (const key of keys) {
  const proof = store.getProof(key);
  if (!proof) continue;
  const t = { key };
  const body = JSON.parse(proof.body);
  console.log(`\nproof ${t.key} (${(proof.body.length / 1024).toFixed(1)} KB)`);
  console.log(`  strategy     ${body.strategy ?? 'beacon'}`);
  console.log(`  block        ${body.blockNumber}  ${body.blockHash}`);
  console.log(`  signed by    ${body.signedBy}, epoch ${body.epoch}, vote in ${body.finalizedBy}`);
  console.log(`  proveroot    ${JSON.stringify(body.proveroot).length} bytes of args`);
  console.log(`  gateway      ${body.gateway?.[3]?.length ?? '?'} trie nodes, log ${body.gateway?.[4]}`);

  // Written out so the two calls can be pushed with cleos, the same way every
  // other proof in this repository is pushed.
  const dir = process.env.DATA_DIR!;
  writeFileSync(`${dir}/proveroot-${t.key.replace(':', '-')}.json`, JSON.stringify(body.proveroot));
  writeFileSync(`${dir}/${body.kind === 'void' ? 'voided' : 'credit'}-${t.key.replace(':', '-')}.json`, JSON.stringify(body.gateway));
  console.log(`  written      ${dir}/`);
}
