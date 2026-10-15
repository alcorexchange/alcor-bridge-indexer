/**
 * Finding where a finalizer policy enters the chain.
 *
 * A policy is published exactly once, on the block where it becomes *pending*,
 * and only over state-history — no HTTP endpoint serves one. From that block
 * until it becomes active there is a short window, two blocks on Telos, in which
 * the certificate is still signed by the PREVIOUS generation while the block's
 * finality digest already commits to the digest of the NEXT one.
 *
 * That window is the whole handover: a certificate from it is verifiable with the
 * policy already on file, and vouches for the successor's digest. Everything
 * about advancing a light client's policy reduces to locating it.
 */

import { fetchFinalityData, fetchStatus } from './ship.ts';
import type { FinalizerPolicy } from './policyDiff.ts';

export type PolicyPublication = {
  /** The block that carries the new policy as pending. */
  block: number;
  policy: FinalizerPolicy;
  /** The generation still signing certificates here — the one a verifier needs. */
  activeGeneration: number;
};

/** The last-pending generation as of a block. */
export async function generationAt(ship: string, blockNum: number): Promise<number> {
  const b = await fetchFinalityData(ship, blockNum);
  return b.finality_data.last_pending_finalizer_policy_generation;
}

/** The publication is older than what state-history holds; no search can reach it now. */
export class BeforeRetention extends Error {}

/**
 * Locate the block that published `generation`.
 *
 * Binary search, with the lower bound walked back by doubling rather than fixed.
 * State-history is retained for a limited span and a probe below it does not fail
 * cleanly — the stream simply never answers — so the node is asked where its
 * finality data begins and the search never probes under it. A publication
 * older than that is reported at once, as `BeforeRetention`, instead of as a
 * timeout a minute later.
 */
export async function findPolicyPublication(
  ship: string,
  head: number,
  generation: number,
  maxSpan = 4_000_000,
): Promise<PolicyPublication> {
  const pub = await firstPublicationFrom(ship, head, generation, maxSpan);
  if (pub.policy.generation !== generation) {
    throw new Error(`block ${pub.block} does not carry generation ${generation} as a pending policy`);
  }
  return pub;
}

/**
 * The first policy published after `held`, whatever its generation.
 *
 * Generations can skip: a proposal superseded before it became pending used up
 * its number and never appears. So the policy that follows `held` on the chain
 * is the first PUBLISHED one above it, not necessarily `held + 1`.
 */
export function findPublicationAfter(
  ship: string,
  head: number,
  held: number,
  maxSpan = 4_000_000,
): Promise<PolicyPublication> {
  return firstPublicationFrom(ship, head, held + 1, maxSpan);
}

/** The first block whose last-pending generation is at least `generation`, as a publication. */
async function firstPublicationFrom(
  ship: string,
  head: number,
  generation: number,
  maxSpan: number,
): Promise<PolicyPublication> {
  let hi = head;
  if ((await generationAt(ship, hi)) < generation) {
    throw new Error(
      `generation ${generation} has not become pending yet ` +
        `(the chain is on ${await generationAt(ship, hi)})`,
    );
  }

  const floor = Math.max(1, (await fetchStatus(ship)).finalityDataBegin ?? 1);
  let lo = hi;
  for (let span = 100_000; ; span *= 2) {
    lo = Math.max(floor, hi - span);
    if ((await generationAt(ship, lo)) < generation) break;
    if (lo === floor) {
      throw new BeforeRetention(
        `generation ${generation} was published before block ${floor}, the oldest finality ` +
          `data state-history still holds`,
      );
    }
    if (span > maxSpan) {
      throw new Error(
        `generation ${generation} is further back than ${span} blocks; state-history ` +
          `has almost certainly pruned the block that published it`,
      );
    }
  }

  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if ((await generationAt(ship, mid)) >= generation) hi = mid;
    else lo = mid + 1;
  }

  const b = await fetchFinalityData(ship, lo);
  const policy = b.finality_data.pending_finalizer_policy;
  if (!policy || policy.generation < generation) {
    throw new Error(`block ${lo} does not carry generation ${generation} or later as a pending policy`);
  }
  return {
    block: lo,
    policy,
    activeGeneration: b.finality_data.active_finalizer_policy_generation,
  };
}
