/**
 * The Sui half of each crossing, from the vault's own events.
 *
 * The Telos half comes from the stream, as on every route: a credit, a burn, a
 * refund. What only Sui knows is written here — the Sui transaction of a
 * deposit, and a withdrawal's end: `Released` (paid; nothing on Telos will ever
 * say so) or `Voided` (expired; the Sui relayer proves it and the ledger's refund
 * ends the row). Events are read by type, `<package>::vault`, which keeps the
 * vault package's original id across upgrades, and only this route's vault
 * counts. The cursor is kept in the store.
 */
import { createHash } from 'node:crypto';

import { getTableRows } from '../../src/net/antelope.ts';
import { uint64ToName } from '../../src/proof/pack.ts';
import { vaultState } from '../../src/sui/client.ts';
import { suiGraphql } from '../../src/sui/proof.ts';
import type { IndexerConfig, SuiConfig } from './config.ts';
import { depositKey, withdrawalKey, type Store } from './db.ts';

/** The vault object the ledger's route to `domain` names, 0x-hex; undefined while there is no route. */
async function routeVault(cfg: IndexerConfig, domain: string): Promise<string | undefined> {
  const routes = await getTableRows<any>(cfg.savanna, { code: cfg.accounts.bridge, table: 'routes' });
  const r = routes.find((x) => String(x.domain) === domain);
  return r ? '0x' + String(r.vault).toLowerCase() : undefined;
}

const packages = new Map<string, string>();

/** Read the vault's new events since the stored cursor and write them; how many were applied. */
export async function followSuiVault(cfg: IndexerConfig, store: Store, sui: SuiConfig): Promise<number> {
  const domain = sui.chain.domain;
  const vault = await routeVault(cfg, domain);
  if (!vault) return 0;
  if (!packages.has(vault)) packages.set(vault, (await vaultState(sui.graphql, vault)).package);
  const type = `${packages.get(vault)}::vault`;

  const cursorKey = `sui:${sui.chain.id}:${vault}:cursor`;
  let applied = 0;
  for (;;) {
    const cursor = store.getMeta(cursorKey);
    const after = cursor ? `, after: "${cursor}"` : '';
    const page = (await suiGraphql(sui.graphql, `{ events(first: 50${after}, filter: { type: "${type}" }) {
      pageInfo { endCursor hasNextPage }
      nodes { timestamp contents { type { repr } json } transaction { digest effects { checkpoint { sequenceNumber } } } } } }`)).events;
    for (const n of page.nodes) {
      const e = n.contents.json;
      if (String(e.vault).toLowerCase() !== vault) continue;
      const name = String(n.contents.type.repr).split('::').pop();
      const tx = String(n.transaction.digest);
      const checkpoint = Number(n.transaction.effects?.checkpoint?.sequenceNumber ?? 0);
      const at = Math.floor(Date.parse(n.timestamp) / 1000);
      if (name === 'Deposit') {
        store.upsertTransfer({
          key: depositKey(domain, Number(e.nonce)),
          direction: 'deposit',
          ref: Number(e.nonce),
          // The credit on Telos moves it on; `seen` never moves a row backwards.
          status: 'seen',
          domain,
          token: createHash('sha256').update(String(e.coin_type)).digest('hex'),
          account: uint64ToName(BigInt(e.telos_to)),
          evm_address: String(e.from),
          amount: String(e.canonical),
          memo: e.memo ? String(e.memo) : undefined,
          src_tx: tx,
          src_block: checkpoint,
          firstSeen: { block: checkpoint, time: at },
        });
        applied++;
      } else if (name === 'Released' || name === 'Voided') {
        store.upsertTransfer({
          key: withdrawalKey(String(e.id)),
          direction: 'withdrawal',
          ref: Number(e.id),
          // An expiry is not the end: the ledger's refund is, read from the stream.
          status: name === 'Released' ? 'released' : 'expired',
          firstSeen: { block: 0, time: at },
          dst_block: checkpoint,
          dst_time: at,
          dst_tx: tx,
        });
        console.log(`[sui] withdrawal ${e.id} ${name === 'Released' ? 'released' : 'expired'} in checkpoint ${checkpoint}`);
        applied++;
      }
    }
    if (page.pageInfo.endCursor) store.setMeta(cursorKey, page.pageInfo.endCursor);
    if (!page.pageInfo.hasNextPage) return applied;
  }
}
