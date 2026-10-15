/**
 * Action receipts, their Savanna digests, and the block's `action_mroot`.
 *
 * This is the last link of a withdrawal proof. An action receipt is what enters
 * `action_mroot`, and `action_mroot` is what a block's finality leaf commits to —
 * which is why a withdrawal has to be announced by an inline action rather than
 * written to a table. A table row proves nothing to anyone off this chain.
 *
 * The digest, from `transaction_trace::digest_savanna` in Spring:
 *
 *   witness = sha256( global_sequence, auth_sequence, code_sequence, abi_sequence )
 *   digest  = sha256( receiver, recv_sequence, act.account, act.name,
 *                     act_digest, witness )
 *
 * Splitting the witness out is deliberate on Spring's part: a proof carries the
 * witness as an opaque 32 bytes, so a verifier on another chain never has to
 * model sequence numbers it cannot check anyway.
 *
 * Traces are decoded with the ABI the state-history socket sends as its own
 * first message, rather than a layout hard-coded here. They are a deep variant
 * structure that changes between Spring releases, and the node is the only
 * authority on which version it is speaking.
 */

import { ABI, Serializer } from '@wharfkit/antelope';
import { sha256 } from '@noble/hashes/sha2.js';

import { Writer } from '../proof/pack.ts';
import { treeRoot } from '../proof/merkle.ts';

const toHex = (b: Uint8Array) => Buffer.from(b).toString('hex');

function fromHex(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, '');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export type ActionReceipt = {
  receiver: string;
  actDigest: string;
  globalSequence: bigint;
  recvSequence: bigint;
  authSequence: Array<[string, bigint]>;
  codeSequence: number;
  abiSequence: number;
};

export type ActionTrace = {
  receiver: string;
  account: string;
  name: string;
  receipt?: ActionReceipt;
  /** Raw action data, hex. */
  data: string;
  /**
   * The transaction this action belongs to.
   *
   * Carried because it is the only place it exists: a proof needs the action and
   * its receipt, but anything showing a crossing to a person needs the hash they
   * can paste into an explorer, and the stream is already delivering it.
   */
  trxId: string;
};

/** sha256 over the sequence numbers a far-side verifier cannot check. */
export function savannaWitness(r: ActionReceipt): Uint8Array {
  const w = new Writer().u64(r.globalSequence).varuint32(r.authSequence.length);
  for (const [account, seq] of r.authSequence) w.name(account).u64(seq);
  w.varuint32(r.codeSequence).varuint32(r.abiSequence);
  return sha256(w.done());
}

/**
 * The receipt-bearing traces of a block, in the order they were executed.
 *
 * Exported because a withdrawal proof needs the same ordering to work out which
 * leaf index its `wdlog` occupies.
 */
export function receiptsInExecutionOrder(traces: ActionTrace[]): ActionTrace[] {
  return traces
    .filter((t) => t.receipt)
    .sort((a, b) => (a.receipt!.globalSequence < b.receipt!.globalSequence ? -1 : 1));
}

/** The leaf an action contributes to `action_mroot`. */
export function actionDigestSavanna(t: ActionTrace): Uint8Array {
  if (!t.receipt) throw new Error('action trace has no receipt and contributes no leaf');
  const w = new Writer()
    .name(t.receipt.receiver)
    .u64(t.receipt.recvSequence)
    .name(t.account)
    .name(t.name)
    .raw(fromHex(t.receipt.actDigest))
    .raw(savannaWitness(t.receipt));
  return sha256(w.done());
}

/** Decode a block's packed `transaction_trace[]` using the socket's own ABI. */
export function decodeTraces(abiJson: string, blob: Uint8Array): ActionTrace[] {
  const abi = ABI.from(JSON.parse(abiJson));
  const decoded = Serializer.decode({
    data: blob,
    type: 'transaction_trace[]',
    abi,
  }) as any[];

  const out: ActionTrace[] = [];
  for (const wrapped of decoded) {
    // Each entry is a variant: [typeName, value].
    const trx = unwrapVariant(wrapped);
    const trxId = String(trx.id ?? '');
    for (const at of trx.action_traces ?? []) {
      const a = unwrapVariant(at);
      const receipt = a.receipt ? unwrapVariant(a.receipt) : undefined;
      out.push({
        receiver: String(a.receiver),
        account: String(a.act.account),
        name: String(a.act.name),
        data: String(a.act.data),
        trxId,
        receipt: receipt
          ? {
              receiver: String(receipt.receiver),
              actDigest: String(receipt.act_digest),
              globalSequence: BigInt(String(receipt.global_sequence)),
              recvSequence: BigInt(String(receipt.recv_sequence)),
              authSequence: (receipt.auth_sequence ?? []).map((s: any) => [
                String(s.account),
                BigInt(String(s.sequence)),
              ]),
              codeSequence: Number(String(receipt.code_sequence)),
              abiSequence: Number(String(receipt.abi_sequence)),
            }
          : undefined,
      });
    }
  }
  return out;
}

/**
 * Antelope wraps most state-history structures in a variant, which decodes as
 * either `[name, value]` or `{ value }` depending on the serializer's mood.
 */
function unwrapVariant(v: any): any {
  const plain = typeof v?.toJSON === 'function' ? v.toJSON() : v;
  if (Array.isArray(plain) && plain.length === 2 && typeof plain[0] === 'string') return plain[1];
  return plain;
}

/**
 * Rebuild a block's `action_mroot` from its traces.
 *
 * Only actions that carry a receipt contribute a leaf; an action without one was
 * never dispatched as its own receipt.
 *
 * **Order is by `global_sequence`, not by the order the traces arrive.** This is
 * the one that bites. State-history emits `action_traces` in creation order —
 * numbered by `action_ordinal`, so a parent is followed by the inline actions it
 * created — while receipts enter `action_mroot` in *execution* order, which is
 * interleaved once inline actions create further inline actions. For a block
 * whose sequences run 249, 250, 251, 254, 257, 260, 252, 253, … the two orders
 * diverge and the rebuilt root is simply wrong.
 *
 * It stays invisible on quiet blocks: anything up to about six receipts on Telos
 * is a lone `onblock` or a flat transfer, where the two orders coincide. It
 * appears the moment a real contract fans out — and it would have made every
 * withdrawal from a busy block unprovable, with nothing to point at.
 *
 * `global_sequence` is the total order of action dispatch since genesis, so it
 * *is* execution order rather than a proxy for it.
 *
 * The tree is Antelope's `calculate_merkle` — left-full, not padded to a power of
 * two. `treeRoot` is that function: decomposing the leaf count by its set bits
 * and folding the perfect sub-trees right to left produces exactly the same
 * shape as merkle.hpp's midpoint recursion, and it is the code the finality-tree
 * checks already validated against live blocks.
 */
export function actionMrootFromTraces(traces: ActionTrace[]): string {
  const leaves = receiptsInExecutionOrder(traces).map((t) => actionDigestSavanna(t));
  // An empty tree is 32 zero bytes, matching merkle.hpp rather than throwing.
  if (leaves.length === 0) return '00'.repeat(32);
  return toHex(treeRoot(leaves));
}
