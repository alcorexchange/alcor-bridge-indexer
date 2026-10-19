/**
 * The NEAR half of each crossing, from the vault's own log lines; and which
 * NEAR account the vault is.
 *
 * On Telos the route's vault is sha256 of the vault's account id, which cannot
 * be read backwards. The route's gateway holds the id in clear
 * (`neargateway::config.vault_account`); it is taken from there and checked to
 * hash to the route's vault, so a gateway naming another account is an error,
 * not a vault.
 *
 * The Telos half of a crossing comes from the stream, as on every route. What
 * only NEAR knows is written here — the NEAR transaction of a deposit, and a
 * withdrawal's end: `released` (paid; nothing on Telos will ever say so) or
 * `voided` (expired; the NEAR relayer proves it and the ledger's refund ends the
 * row). The vault's transactions are found through FastNEAR's account history
 * (`<PREFIX>_TX_API`) and read from the RPC; nothing here moves money, it only
 * labels rows. The cursor (a block height) is kept in the store.
 */
import { getTableRows } from '../../src/net/antelope.ts';
import { indexedHeight, nearVaultTxs } from '../../src/near/discover.ts';
import { nearAddress } from '../../src/near/logs.ts';
import { nearRpc } from '../../src/near/rpc.ts';
import { uint64ToName } from '../../src/proof/pack.ts';
import type { IndexerConfig, NearConfig } from './config.ts';
import { depositKey, withdrawalKey, type Store } from './db.ts';

export type NearRoute = {
  /** The vault's NEAR account id. */
  vault: string;
  /** sha256 of it, hex: the route's vault on Telos. */
  address: string;
  gateway: string;
  lightClient: string;
};

const routes = new Map<string, { at: number; route: Promise<NearRoute | undefined> }>();

/** The vault the ledger's route to `domain` names, read through its gateway; undefined while there is no route. */
export function nearRouteOf(cfg: IndexerConfig, domain: string): Promise<NearRoute | undefined> {
  const hit = routes.get(domain);
  if (hit && Date.now() - hit.at < 60_000) return hit.route;
  const route = (async () => {
    const all = await getTableRows<any>(cfg.savanna, { code: cfg.accounts.bridge, table: 'routes' });
    const r = all.find((x) => String(x.domain) === domain);
    if (!r) return undefined;
    const gateway = String(r.gateway);
    const [g] = await getTableRows<any>(cfg.savanna, { code: gateway, scope: gateway, table: 'config', limit: 1 });
    if (!g?.vault_account) throw new Error(`near: the gateway ${gateway} names no vault account`);
    const vault = String(g.vault_account);
    const address = String(r.vault).toLowerCase();
    if (nearAddress(vault) !== address) {
      throw new Error(`near: the gateway ${gateway} names ${vault}, which is not the route's vault ${address}`);
    }
    return { vault, address, gateway, lightClient: String(g.light_client) };
  })();
  route.catch(() => routes.delete(domain));
  routes.set(domain, { at: Date.now(), route });
  return route;
}

/** Account ids the vault's logs named, by their sha256: how a withdrawal to a hash finds its account. */
export const nearAccountKey = (address: string) => `near:account:${address.replace(/^0x/, '').toLowerCase()}`;

/** How far behind the final head a transaction is read: its receipts have all run by then. */
const SETTLE_BLOCKS = 30;

/** Read the vault's new transactions since the stored cursor and write what their logs say; how many were applied. */
export async function followNearVault(cfg: IndexerConfig, store: Store, near: NearConfig): Promise<number> {
  const domain = near.chain.domain;
  const route = await nearRouteOf(cfg, domain);
  if (!route) return 0;
  const vault = route.vault;

  const head = Number((await nearRpc(near.rpc, 'block', { finality: 'final' })).header.height);
  // Not past what FastNEAR has indexed: beyond it the history is short, not missing.
  const to = Math.min(head, await indexedHeight(near)) - SETTLE_BLOCKS;
  const cursorKey = `near:${near.chain.id}:${vault}:height`;
  const from = Number(store.getMeta(cursorKey) ?? 0) + 1;
  if (to < from) return 0;

  let applied = 0;
  for await (const t of nearVaultTxs(near, vault, from, to)) {
    for (const { log, height, time } of t.logs) {
      if (log.kind === 'deposit') {
        for (const id of [log.from, log.refundTo]) store.setMeta(nearAccountKey(nearAddress(id)), id);
        store.upsertTransfer({
          key: depositKey(domain, Number(log.nonce)),
          direction: 'deposit',
          ref: Number(log.nonce),
          // The credit on Telos moves it on; `seen` never moves a row backwards.
          status: 'seen',
          domain,
          token: nearAddress(log.token),
          account: uint64ToName(log.telosTo),
          evm_address: log.from,
          amount: log.canonical.toString(),
          memo: log.memo.length ? log.memo.toString('utf8') : undefined,
          src_tx: t.hash,
          src_block: height,
          firstSeen: { block: height, time },
        });
        applied++;
      } else if (log.kind === 'released' || log.kind === 'voided') {
        if (log.kind === 'released') store.setMeta(nearAccountKey(nearAddress(log.recipient)), log.recipient);
        store.upsertTransfer({
          key: withdrawalKey(String(log.id)),
          direction: 'withdrawal',
          ref: Number(log.id),
          // An expiry is not the end: the ledger's refund is, read from the stream.
          status: log.kind === 'released' ? 'released' : 'expired',
          firstSeen: { block: 0, time },
          dst_block: height,
          dst_time: time,
          dst_tx: t.hash,
        });
        console.log(`[near] withdrawal ${log.id} ${log.kind === 'released' ? 'released' : 'expired'} in block ${height}`);
        applied++;
      } else if (log.kind === 'release_failed') {
        // The vault put the id back: it may be released again, or expire. The row stays open.
        console.log(`[near] withdrawal ${log.id}: a release failed in block ${height} (${t.hash}); still open`);
      }
    }
    // A crash mid-height re-reads that height: every write above is an upsert.
    store.setMeta(cursorKey, String(t.txHeight - 1));
  }
  store.setMeta(cursorKey, String(to));
  return applied;
}
