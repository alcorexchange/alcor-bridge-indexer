/**
 * What the Antelope chains' relayers carried (WAX, XPR, Vaulta), read from the
 * files they append beside the indexer (`RELAYER_DIR`).
 *
 * The indexer follows Telos and sees every burn and every credit there. The far
 * half of a crossing — the deposit's transaction on WAX, XPR or Vaulta, the release's —
 * it cannot see: only the relayer that proved it holds those. So each relayer
 * appends one line per crossing to its own directory (`<chain>-in`,
 * `<chain>-out`), and this reads the files from where it left off. A byte offset in `meta`
 * remembers the position; a line read twice does the same upsert twice.
 */
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { depositKey, withdrawalKey, type Store } from './db.ts';

export function ingestCrossings(store: Store, dir: string, names: readonly string[]): number {
  let applied = 0;
  for (const name of names) {
    const file = join(dir, name, 'crossings.jsonl');
    if (!existsSync(file)) continue;
    const metaKey = `crossings:${name}`;
    const from = store.getNumber(metaKey) ?? 0;
    const size = statSync(file).size;
    if (size <= from) continue;
    const chunk = readFrom(file, from, size - from);
    const complete = chunk.lastIndexOf('\n');
    if (complete < 0) continue; // a line still being written
    for (const line of chunk.slice(0, complete).split('\n')) {
      if (!line.trim()) continue;
      try {
        apply(store, JSON.parse(line));
        applied++;
      } catch (err) {
        console.log(`[crossings] ${name}: ${(err as Error).message}`);
      }
    }
    store.setMeta(metaKey, String(from + complete + 1));
  }
  return applied;
}

/** The file from `offset` on; the part already applied is not read again. */
function readFrom(file: string, offset: number, length: number): string {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(length);
    const got = readSync(fd, buf, 0, length, offset);
    return buf.subarray(0, got).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

function apply(store: Store, c: any): void {
  if (c.kind === 'deposit') {
    const key = depositKey(String(c.domain), Number(c.nonce));
    // Written once when the log is seen on its chain and once when its proof lands
    // on Telos; only the second carries the Telos transaction. The status
    // itself comes from the Telos stream, which sees the credit: `seen` never
    // moves a row backwards.
    store.upsertTransfer({
      key,
      direction: 'deposit',
      ref: Number(c.nonce),
      status: 'seen',
      domain: String(c.domain),
      token: c.token ? String(c.token).toLowerCase() : undefined,
      account: c.beneficiary ? String(c.beneficiary) : undefined,
      evm_address: c.from ? String(c.from) : undefined,
      amount: c.amount ? String(c.amount) : undefined,
      memo: c.memo ? String(c.memo) : undefined,
      src_tx: String(c.wax_tx),
      src_block: Number(c.wax_block),
      firstSeen: { block: Number(c.wax_block), time: Number(c.at) },
      dst_tx: c.telos_tx ? String(c.telos_tx) : undefined,
    });
  } else if (c.kind === 'withdrawal') {
    const key = withdrawalKey(String(c.id));
    store.upsertTransfer({
      key,
      direction: 'withdrawal',
      ref: Number(c.id),
      // A release is the end of it. An expiry is not: the ledger's refund is,
      // and the reconcile pass reads that from the ledger. `burned` never moves
      // a row backwards, so it leaves whatever status the stream has written.
      status: c.action === 'release' ? 'released' : 'burned',
      firstSeen: { block: Number(c.telos_block), time: Number(c.at) },
      dst_tx: String(c.wax_tx),
      dst_time: Number(c.at),
    });
  } else if (c.kind === 'voided') {
    const key = withdrawalKey(String(c.id));
    const known = store.getTransfer(key);
    // Seen on its chain it is `expired`, the way a Voided log on an EVM chain is;
    // proved on Telos it is `refunded`, and the refund is the third transaction.
    store.upsertTransfer({
      key,
      direction: 'withdrawal',
      ref: Number(c.id),
      status: c.telos_tx ? 'refunded' : 'expired',
      firstSeen: { block: 0, time: Number(c.at) },
      dst_block: Number(c.wax_block),
      dst_time: known?.dst_time ?? Number(c.at),
      dst_tx: known?.dst_tx ?? String(c.wax_tx),
      refund_tx: c.telos_tx ? String(c.telos_tx) : undefined,
    });
  }
}
