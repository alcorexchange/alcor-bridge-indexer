/**
 * The Savanna finality digest — the thing a finalizer actually signs.
 *
 * Three nested SHA-256 commitments, transcribed from
 * `block_header_state::compute_finality_digest` and the FC_REFLECT declarations
 * beside it:
 *
 *   level 3   reversible_blocks_mroot, latest_qc_claim_{block_num,
 *             finality_digest, timestamp}, this block's timestamp, base_digest
 *   level 2   last pending policy digest, its start timestamp, sha256(level 3)
 *   digest    major/minor version, active generation, last pending generation,
 *             finality tree digest, sha256(level 2)
 *
 * Everything for level 3 arrives in `finality_data` over state-history. Level 2
 * is the part Wire never had to solve: with one finalizer since genesis its two
 * inputs were constants, while on Telos the policy rotates twice a day, so the
 * digest and start timestamp of the last pending policy have to be tracked
 * block by block. That is what `PolicyTracker` is for.
 */

import { sha256 } from '@noble/hashes/sha2.js';

import { Writer, timestampToSlot, type SlotEpoch } from '../proof/pack.ts';
import { policyDigestBytes, type FinalizerPolicy } from './policyDiff.ts';
import type { FinalityData } from './ship.ts';

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const toHex = (b: Uint8Array) => Buffer.from(b).toString('hex');

export type DigestInputs = {
  finalityData: FinalityData;
  /**
   * The finality tree root for this block.
   *
   * Under Savanna the header's `action_mroot` field carries this, not an action
   * root — the real action root moved into `finality_data.action_mroot`. Two
   * fields with almost the same name meaning different things is exactly the
   * kind of thing that produces a digest that will not verify.
   */
  finalityMroot: string;
  /** This block's timestamp: an ISO string or an already-computed slot. */
  timestamp: string | number;
  /** Digest of the last pending finalizer policy, and when it became pending. */
  lastPendingPolicyDigest: string;
  lastPendingPolicyStartSlot: number;
};

export function level3Digest(chain: SlotEpoch, i: DigestInputs): Uint8Array {
  const fd = i.finalityData;
  const w = new Writer()
    .raw(hexToBytes(fd.reversible_blocks_mroot))
    .u32(fd.latest_qc_claim_block_num)
    .raw(hexToBytes(fd.latest_qc_claim_finality_digest))
    .u32(fd.latest_qc_claim_timestamp)
    .u32(typeof i.timestamp === 'number' ? i.timestamp : timestampToSlot(chain, i.timestamp))
    .raw(hexToBytes(fd.base_digest));
  return sha256(w.done());
}

export function level2Digest(chain: SlotEpoch, i: DigestInputs): Uint8Array {
  const w = new Writer()
    .raw(hexToBytes(i.lastPendingPolicyDigest))
    .u32(i.lastPendingPolicyStartSlot)
    .raw(level3Digest(chain, i));
  return sha256(w.done());
}

export function finalityDigest(chain: SlotEpoch, i: DigestInputs): string {
  const fd = i.finalityData;
  const w = new Writer()
    .u32(fd.major_version)
    .u32(fd.minor_version)
    .u32(fd.active_finalizer_policy_generation)
    .u32(fd.last_pending_finalizer_policy_generation)
    .raw(hexToBytes(i.finalityMroot))
    .raw(level2Digest(chain, i));
  return toHex(sha256(w.done()));
}

/**
 * Tracks which finalizer policy is "last pending" as blocks go by, and what its
 * digest and start timestamp are.
 *
 * The rule the chain uses: when `finality_data` carries a
 * `pending_finalizer_policy`, that policy becomes the last pending one, and the
 * block carrying it is where it starts. Its digest and start timestamp then feed
 * level 2 of every subsequent block's digest until the next one supersedes it.
 *
 * A tracker started mid-chain has no history, so it needs one block that
 * publishes a pending policy before it can produce digests — which on Telos means
 * waiting at most twelve hours, or seeding it from a known generation.
 */
export class PolicyTracker {
  private digestByGeneration = new Map<number, string>();
  private startSlotByGeneration = new Map<number, number>();

  /** Feed every block in order. Returns the policy it learned, if any. */
  observe(
    chain: SlotEpoch,
    blockTimestamp: string | number,
    fd: FinalityData,
  ): FinalizerPolicy | undefined {
    const p = fd.pending_finalizer_policy;
    if (!p) return undefined;
    const slot =
      typeof blockTimestamp === 'number' ? blockTimestamp : timestampToSlot(chain, blockTimestamp);
    this.digestByGeneration.set(p.generation, toHex(policyDigestBytes(p)));
    this.startSlotByGeneration.set(p.generation, slot);
    return p;
  }

  /** Seed a generation learned elsewhere — a header diff, or a prior run. */
  seed(generation: number, digest: string, startSlot: number): void {
    this.digestByGeneration.set(generation, digest);
    this.startSlotByGeneration.set(generation, startSlot);
  }

  /**
   * Everything the tracker has learned, in a form `seed` takes back.
   *
   * A tracker is only filled by watching blocks go by, and a policy becomes
   * pending roughly twice a day — so a process that starts near the block it
   * cares about knows nothing and can compute no digest at all. Carrying this
   * beside a tree frontier is what lets a checkpoint stand on its own instead of
   * requiring tens of thousands of blocks of warm-up before it.
   */
  snapshot(): { generation: number; digest: string; startSlot: number }[] {
    return [...this.digestByGeneration.entries()]
      .map(([generation, digest]) => ({
        generation,
        digest,
        startSlot: this.startSlotByGeneration.get(generation)!,
      }))
      .sort((a, b) => a.generation - b.generation);
  }

  /** Restore a `snapshot`. */
  restore(entries: { generation: number; digest: string; startSlot: number }[]): void {
    for (const e of entries) this.seed(e.generation, e.digest, e.startSlot);
  }

  known(generation: number): boolean {
    return this.digestByGeneration.has(generation);
  }

  /** The level-2 inputs for a block, by the generation its finality data names. */
  lastPending(generation: number): { digest: string; startSlot: number } {
    const digest = this.digestByGeneration.get(generation);
    const startSlot = this.startSlotByGeneration.get(generation);
    if (digest === undefined || startSlot === undefined) {
      throw new Error(
        `no policy recorded for generation ${generation} — ` +
          `the tracker has not seen the block that made it pending`,
      );
    }
    return { digest, startSlot };
  }
}
