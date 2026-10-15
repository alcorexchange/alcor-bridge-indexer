/**
 * What a block's bridge events do to the stored crossings.
 *
 * The stream is the fast path: it sees a step of a crossing half a second after
 * it happens, with the transaction it rode in, which the tables never record.
 * The tables stay the authority and reconciliation corrects anything written
 * here a minute later — so this only writes, and asks nothing of any node.
 *
 * A step that is not where a crossing starts — a credit, a refund — places a row
 * it creates at the block it was seen in with no source block (`firstSeen`
 * `{ block: 0, ... }`); the source side fills that in when it is read.
 */

import { Store, withdrawalKey, depositKey, externalToken } from './db.ts';
import type { BridgeEvent } from './bridgeActions.ts';

/** Write every event of block `block`, whose time is `at` (epoch seconds). */
export function applyBridgeEvents(store: Store, events: BridgeEvent[], block: number, at: number): void {
  const firstSeen = { block: 0, time: at };

  for (const e of events) {
    if (e.kind === 'burn') {
      // Bound for an Antelope chain: that chain's relayer proves it and the
      // vault over there pays; what that side did comes in through its
      // crossings file.
      store.upsertTransfer({
        key: withdrawalKey(e.id.toString()),
        direction: 'withdrawal',
        ref: Number(e.id),
        status: 'burned',
        evm_address: e.recipient,
        token: e.token,
        amount: e.amount.toString(),
        domain: e.domain.toString(),
        src_block: block,
        src_time: at,
        src_tx: e.trxId,
        deadline: Number(e.deadline),
      });
    } else if (e.kind === 'credit') {
      store.upsertTransfer({
        key: depositKey(e.domain, e.nonce),
        direction: 'deposit',
        ref: e.nonce,
        // A memo always parks. Without one the bridge parks only for an
        // account that does not exist, which the action does not say — so the
        // caller asks the table, once, after the fact.
        status: e.memo ? 'parked' : 'credited',
        account: e.beneficiary,
        domain: e.domain,
        token: externalToken(e.domain, e.extToken),
        amount: e.canonical.toString(),
        firstSeen,
        dst_block: block,
        dst_time: at,
        dst_tx: e.trxId,
      });
      console.log(`[savanna] deposit #${e.nonce} credited to ${e.beneficiary} in block ${block}`);
    } else if (e.kind === 'forward' || e.kind === 'bounce') {
      store.upsertTransfer({
        key: depositKey(e.domain, e.nonce),
        direction: 'deposit',
        ref: e.nonce,
        status: e.kind === 'forward' ? 'forwarded' : 'bounced',
        firstSeen,
        // The transaction that finished it here: the delivery, or the
        // withdrawal that sends it back.
        dst_tx: e.trxId,
      });
      console.log(
        `[savanna] deposit #${e.nonce} on ${e.domain} ` +
          `${e.kind === 'forward' ? 'forwarded' : 'sent back'} in block ${block}`,
      );
    } else if (e.kind === 'refund') {
      store.upsertTransfer({
        key: withdrawalKey(e.id),
        direction: 'withdrawal',
        ref: e.id,
        status: 'refunded',
        firstSeen,
        refund_tx: e.trxId,
      });
      console.log(`[savanna] withdrawal ${e.id} refunded in block ${block}`);
    } else if (e.kind === 'claim') {
      store.recordClaim(e.trxId, e.owner, e.symbolCode, block, at);
      console.log(`[savanna] ${e.owner} claimed ${e.symbolCode} in block ${block}`);
    } else if (e.kind === 'hop') {
      // A deposit reaches the hop contract by `forward`, or by a solver's
      // `fill`, in the very transaction whose `bind` records the hop. A way back
      // names its hop in `prev` and has no deposit.
      const arrival = e.prev
        ? undefined
        : events.find(
            (x): x is Extract<BridgeEvent, { kind: 'forward' | 'fill' }> =>
              (x.kind === 'forward' || x.kind === 'fill') && x.trxId === e.trxId,
          );
      const deposit = arrival ? depositKey(arrival.domain, arrival.nonce) : null;
      store.putHop({
        id: e.id,
        prev: e.prev || null,
        deposit,
        quantity: e.quantity,
        to_domain: e.toDomain,
        to_recipient: e.to,
        back_domain: e.backDomain,
        back_recipient: e.back,
        tx: e.trxId,
        block,
        at,
      });
      console.log(
        `[savanna] hop ${e.id}: ${e.quantity} to ${e.toDomain}:${e.to}` +
          (e.prev ? `, sending hop ${e.prev} back` : deposit ? `, carrying ${deposit} on` : '') +
          ` in block ${block}`,
      );
    }
  }
}
