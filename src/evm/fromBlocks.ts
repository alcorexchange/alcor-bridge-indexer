/**
 * Assemble a light-client update from beacon blocks.
 *
 * `light_client/optimistic_update` only ever describes the current head, so a
 * block whose moment passed cannot be fetched from it. The data itself is not
 * lost: a head's `sync_aggregate` travels in the body of the next *proposed*
 * beacon block and stays in the chain. Reading those two blocks reconstructs
 * exactly what the endpoint would have returned, for any slot the node retains.
 *
 * This is what keeps a deposit provable across restarts, downtime and a stale
 * signature cache.
 */
import { ssz } from '@lodestar/types';
import { Tree } from '@chainsafe/persistent-merkle-tree';
import { BLOCK_BODY_EXECUTION_PAYLOAD_GINDEX } from '@lodestar/params';
import { BeaconClient, SECONDS_PER_SLOT } from './beacon.ts';
import { toHex } from '../proof/hex.ts';
import { BEACON_GENESIS_TIME as GENESIS_TIME } from '../config.ts';

// GENESIS_TIME comes from the chain registry. The predecessor defaulted it to
// Sepolia's genesis, which on any other network yields a slot number that is
// wrong and therefore a block belonging to somebody else — with no error.

export const slotForTimestamp = (unixSeconds: number): number =>
  Math.round((unixSeconds - GENESIS_TIME) / SECONDS_PER_SLOT);

/**
 * Rebuild the optimistic update for `slot`.
 *
 * The execution branch is computed from the block body rather than served: the
 * light-client endpoint hands it over, a raw block does not.
 */
/**
 * The execution payload as a light-client header would report it.
 *
 * Only two fields differ: the transaction and withdrawal lists become their
 * hash tree roots. Everything else is copied through, so the JSON shape the
 * rest of the pipeline already parses stays intact.
 */
function payloadToHeaderJson(payloadJson: any, body: any): any {
  const { transactions, withdrawals, ...rest } = payloadJson;
  return {
    ...rest,
    transactions_root: '0x' + toHex(ssz.fulu.Transactions.hashTreeRoot(body.executionPayload.transactions)),
    withdrawals_root: '0x' + toHex(ssz.capella.Withdrawals.hashTreeRoot(body.executionPayload.withdrawals)),
  };
}

export async function updateFromBlocks(beacon: BeaconClient, slot: number): Promise<any> {
  const [signed, next] = await Promise.all([
    beacon.blockAtSlot(slot),
    beacon.blockAfterSlot(slot),
  ]);

  const message = signed.data.message;
  const body = ssz.fulu.BeaconBlockBody.fromJson(message.body);
  const bodyView = ssz.fulu.BeaconBlockBody.toView(body);

  const witnesses = new Tree(bodyView.node)
    .getSingleProof(BigInt(BLOCK_BODY_EXECUTION_PAYLOAD_GINDEX))
    .map((w) => '0x' + toHex(new Uint8Array(w)));

  return {
    attested_header: {
      // A raw block carries the full execution payload; a light-client header
      // carries its *header*, where the transaction and withdrawal lists are
      // replaced by their roots. The proof hashes the header, so convert.
      execution: payloadToHeaderJson(message.body.execution_payload, body),
      beacon: {
        slot: message.slot,
        proposer_index: message.proposer_index,
        parent_root: message.parent_root,
        state_root: message.state_root,
        body_root: '0x' + toHex(ssz.fulu.BeaconBlockBody.hashTreeRoot(body)),
      },
      execution_branch: witnesses,
    },
    // The aggregate in the next proposed block is the committee's signature
    // over this one. Usually that is slot + 1; when slot + 1 was missed the
    // aggregate simply rides in the block after the gap, still signing this
    // header, and the domain and committee follow the slot it landed in.
    sync_aggregate: next.block.data.message.body.sync_aggregate,
    signature_slot: String(next.slot),
  };
}

/**
 * Collect `count` consecutive beacon headers starting at `fromSlot`, and report
 * the slot that sits just above them.
 *
 * Counts BLOCKS, not slots. A beacon slot can be empty — the proposer missed it —
 * so asking for twelve slots can yield ten headers, and ten is then the honest
 * depth. Walking until the count is met keeps "twelve confirmations" meaning
 * twelve blocks built on top, which is what the phrase is worth.
 *
 * `maxSlots` bounds the walk so a long run of empty slots fails loudly instead
 * of scanning forever.
 */
export async function ancestryOfLength(
  beacon: BeaconClient,
  fromSlot: number,
  count: number,
  maxSlots = count * 4 + 16,
): Promise<{ headers: Awaited<ReturnType<typeof ancestryTo>>; tipSlot: number }> {
  const headers: Awaited<ReturnType<typeof ancestryTo>> = [];
  let slot = fromSlot;
  const limit = fromSlot + maxSlots;
  while (headers.length < count && slot < limit) {
    const h = await beacon.headerAtSlotOrNull(slot);
    if (h) {
      headers.push({
        slot: Number(h.slot),
        proposer_index: Number(h.proposer_index),
        parent_root: h.parent_root,
        state_root: h.state_root,
        body_root: h.body_root,
      });
    }
    slot++;
  }
  if (headers.length < count) {
    throw new Error(
      `only ${headers.length} of ${count} headers in slots ${fromSlot}..${slot - 1}`,
    );
  }
  // The tip is the next block above the chain; empty slots are skipped again.
  let tipSlot = slot;
  while (tipSlot < limit + 16 && !(await beacon.headerAtSlotOrNull(tipSlot))) tipSlot++;
  return { headers, tipSlot };
}

/**
 * The chain of beacon headers from `fromSlot` up to `toSlot`, top exclusive,
 * ascending. Its length is the confirmation depth a contract can verify.
 *
 * Uses `/eth/v1/beacon/headers/{slot}`, which returns exactly the five fields a
 * `BeaconBlockHeader` has. Fetching whole blocks and hashing their bodies would
 * give the same answer for several megabytes more traffic.
 *
 * Slots can be empty, so a missing one is skipped rather than treated as an
 * error: the result is a run of real blocks, which is what a confirmation
 * counts. The caller gets fewer headers than slots asked for, and that lower
 * number is the honest depth.
 */
export async function ancestryTo(
  beacon: BeaconClient,
  fromSlot: number,
  toSlot: number,
): Promise<
  Array<{
    slot: number;
    proposer_index: number;
    parent_root: string;
    state_root: string;
    body_root: string;
  }>
> {
  const out = [];
  for (let slot = fromSlot; slot < toSlot; slot++) {
    const header = await beacon.headerAtSlotOrNull(slot);
    if (!header) continue;
    out.push({
      slot: Number(header.slot),
      proposer_index: Number(header.proposer_index),
      parent_root: header.parent_root,
      state_root: header.state_root,
      body_root: header.body_root,
    });
  }
  return out;
}
