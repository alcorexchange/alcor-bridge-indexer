/**
 * Which settlement-chain block each trusted root was taken as of.
 *
 * An EVM light client's `RootAccepted` names the root and a timestamp slot, not
 * a block. The block is what decides whether a withdrawal can fold into that
 * root on the cheap track, and only the settlement chain can map one to the
 * other — so this runs once per reconciliation for every source chain's roots
 * together, rather than once per follower over the same table.
 */

import type { SavannaChain } from '../../src/chains/savanna.ts';
import { getBlock, getInfo } from '../../src/net/antelope.ts';
import { timestampToSlot } from '../../src/proof/pack.ts';
import { headerSlot } from '../../src/savanna/treeBuilder.ts';
import type { Store } from './db.ts';

/**
 * Fill in the block of every root recorded without one. A short binary search
 * per root, cached forever afterwards in the row itself. Returns how many.
 */
export async function resolveRootBlocks(store: Store, chain: SavannaChain): Promise<number> {
  let done = 0;
  for (const r of store.rootsWithoutBlock()) {
    const block = await rootBlockAtSlot(chain, r.slot);
    if (block === undefined) continue;
    store.putRoot(r.mroot, r.slot, block, 0, r.domain);
    done++;
  }
  return done;
}

/**
 * Which block carries a given timestamp slot.
 *
 * Not a search over the whole chain. Block numbers and slots both advance by one
 * per block, so the head gives an estimate that is off only by however many
 * blocks were missed since — a handful over days on Telos. Searching a window
 * around that estimate rather than from the tree's genesis matters for a real
 * reason: a node that was started last week does not have last month's blocks in
 * its log, and a probe into that range answers HTTP 400, not "older than me".
 */
const SLOT_SEARCH_WINDOW = 8_192;

export async function blockAtSlot(chain: SavannaChain, slot: number): Promise<number | undefined> {
  const info = await getInfo(chain);
  const headSlot = timestampToSlot(chain, info.head_block_time);
  const estimate = info.head_block_num - (headSlot - slot);

  const floor = chain.finalityGenesisBlock ?? 1;
  let lo = Math.max(floor, estimate - SLOT_SEARCH_WINDOW);
  let hi = Math.min(info.head_block_num, estimate + SLOT_SEARCH_WINDOW);

  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const at = await headerSlot(chain, mid);
    if (at === slot) return mid;
    if (at < slot) lo = mid + 1;
    else hi = mid - 1;
  }
  return undefined; // outside the window, or a slot no block occupies
}

/**
 * Which block a trusted root is the tree AS OF, from the slot its event names.
 *
 * Two steps, and skipping the second is an off-by-one that fails quietly. A
 * `RootAccepted` carries the timestamp of the block that CARRIES the root, and
 * under Savanna a block's `action_mroot` is the finality tree root as of the
 * block its quorum certificate CLAIMS — normally its predecessor, but further
 * back whenever a block has no certificate of its own.
 *
 * Record the carrier instead and every re-branch is built one block too late,
 * computes a different root, and is thrown away — so the cheap 135k-gas track
 * is never offered and nothing anywhere says why.
 */
export async function rootBlockAtSlot(chain: SavannaChain, slot: number): Promise<number | undefined> {
  const carrier = await blockAtSlot(chain, slot);
  if (carrier === undefined) return undefined;
  const claimed = (await getBlock(chain, carrier)).finality_extension?.qc_claim?.block_num;
  return typeof claimed === 'number' ? claimed : undefined;
}
