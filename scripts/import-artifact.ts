/**
 * Put a hand-built withdrawal artifact into an indexer's database.
 *
 * The indexer freezes everything it sees from the moment it starts following,
 * and backfills anything older from its leaf window. What it cannot reach is a
 * burn from before its first checkpoint: a branch needs a tree that appended the
 * leaf itself, so the replay has to start strictly before the burn, and if no
 * checkpoint exists there the only way back is a replay from the genesis seed —
 * which needs state-history the node no longer retains.
 *
 * That gap is real and narrow, and `scripts/build-withdrawal.ts` is what fills
 * it: run against an archive or a node with deep retention, it produces exactly
 * the artifact the indexer would have frozen. This puts that file where the
 * indexer serves it from.
 *
 * The artifact is re-checked on the way in rather than trusted, in two ways that
 * between them leave nothing to edit:
 *
 *   the tree branch   must fold the leaf to the root the artifact names
 *   the payload       must match the bridge contract's own `wdraws` row
 *
 * The second is there because the first does not cover it. Amount, recipient and
 * deadline are bound to the root through the action digest, and rebuilding that
 * digest here would mean a second implementation of what `AlcorWithdrawals`
 * already does in Solidity — a copy that can disagree, on the one path where a
 * disagreement is a proof that folds to the wrong withdrawal. Asking the chain
 * what it recorded is cheaper and is not a copy of anything.
 *
 *   node scripts/import-artifact.ts <artifact.json> <indexer.sqlite>
 */

import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { foldProof } from '../src/proof/merkle.ts';
import { finalityLeafBytes } from '../src/savanna/tree.ts';
import { leftAt } from '../src/savanna/withdrawalProof.ts';
import { savannaChain } from '../src/chains/savanna.ts';
import { getTableRows } from '../src/net/antelope.ts';
import type { WithdrawalArtifact } from '../src/savanna/withdrawalArtifact.ts';

const [file, dbFile] = process.argv.slice(2);
if (!file || !dbFile) {
  throw new Error('usage: import-artifact.ts <artifact.json> <indexer.sqlite>');
}

const chain = savannaChain(process.env.SAVANNA_CHAIN ?? 'telos-mainnet');
const body = readFileSync(file, 'utf8');
const artifact = JSON.parse(body) as WithdrawalArtifact;
const r = artifact.release;

if (!r || artifact.burnBlock === undefined || !artifact.submitRoot) {
  throw new Error(`${file} is not a withdrawal artifact`);
}

// The two folds that make it a proof, checked again here. A file that has been
// edited, truncated or swapped fails on one of them.
const bare = (h: string) => h.replace(/^0x/, '').toLowerCase();
const leaf = finalityLeafBytes(chain, {
  majorVersion: r.majorVersion,
  minorVersion: r.minorVersion,
  blockNum: r.blockNum,
  timestamp: r.timestamp,
  parentTimestamp: r.parentTimestamp,
  finalityDigest: r.finalityDigest,
  actionMroot: r.actionMroot,
});
const steps = r.treeSiblings.map((sibling: string, i: number) => ({
  sibling: bare(sibling),
  left: leftAt(r.treePath, i),
}));
const folded = Buffer.from(foldProof(leaf, steps)).toString('hex');
if (folded !== bare(r.finalityMroot)) {
  throw new Error(`the tree branch folds to ${folded}, not to ${bare(r.finalityMroot)}`);
}
if (Number(r.blockNum) !== Number(artifact.burnBlock)) {
  throw new Error(`the leaf is for block ${r.blockNum} but the artifact says ${artifact.burnBlock}`);
}
if (bare(artifact.submitRoot.finality.finalityMroot) !== bare(r.finalityMroot)) {
  throw new Error('the submitRoot half names a different root than the release half');
}

// What the bridge contract itself recorded for this id. The row is the oracle:
// it is what the burn wrote, and nothing in a file on disk can change it.
const [row] = await getTableRows<{
  id: number | string;
  amount: number | string;
  domain: number | string;
  recipient: string;
  deadline: number | string;
  block_num: number;
}>(chain, {
  code: chain.accounts.bridge,
  table: 'wdraws',
  lower_bound: Number(r.id),
  limit: 1,
});
if (!row || Number(row.id) !== Number(r.id)) {
  throw new Error(`${chain.accounts.bridge} has no withdrawal ${r.id}`);
}

const disagreements: string[] = [];
const check = (what: string, got: unknown, want: unknown) => {
  if (String(got).toLowerCase() !== String(want).toLowerCase()) {
    disagreements.push(`${what}: artifact says ${got}, the chain says ${want}`);
  }
};
check('amount', r.amount, row.amount);
check('domain', r.domain, row.domain);
check('recipient', bare(r.recipient), bare(row.recipient));
check('deadline', r.deadline, row.deadline);
check('burn block', artifact.burnBlock, row.block_num);
if (disagreements.length) {
  throw new Error(`the artifact does not match the chain:\n  ${disagreements.join('\n  ')}`);
}

const key = `w:${r.id}`;
const db = new DatabaseSync(dbFile);
db.prepare(
  `INSERT INTO proofs (key, kind, body, bytes, created_at) VALUES (?,?,?,?,?)
   ON CONFLICT(key) DO UPDATE SET body = excluded.body, bytes = excluded.bytes`,
).run(key, 'withdrawal', body, Buffer.byteLength(body), Math.floor(Date.now() / 1000));

// Reconciliation owns the transfer row; only the proof is imported here, and the
// next pass will notice it and move the row to `provable` on its own.
db.close();

console.log(`imported ${key}: burn block ${artifact.burnBlock}, root ${r.finalityMroot}`);
console.log(`  ${r.amount} canonical units to ${r.recipient} on domain ${r.domain}`);
console.log(
  `  branch folds to its root, halves agree, payload matches ${chain.accounts.bridge}'s own ` +
    `record — ${Buffer.byteLength(body)} bytes stored`,
);
