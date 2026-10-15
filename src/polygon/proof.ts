/**
 * `polylightcl`'s arguments, built against the validator set it holds right now.
 *
 * Unlike a Parlia proof, a milestone proof is not good forever: it carries a
 * Heimdall commit, and the light client accepts a commit only from the set it
 * currently trusts. Heimdall's powers move about hourly, so a proof frozen in
 * the morning is under a set the client let go of by noon. Hence these build
 * live, from the client's own `trusted` row, and the indexer stores only the
 * receipt half (which never goes stale) and asks here when a proof is wanted.
 */

import type { EvmChain } from '../chains/evm.ts';
import { antelopeRpc, type RpcEndpoints } from '../net/antelope.ts';
import {
  borChain, comet, commitArgs, heimdallOf, latestHeight, milestoneArgs, milestoneCovering,
  validatorArgs, validatorSet, type Member,
} from './heimdall.ts';

/** The light client's trusted set, as its table holds it. */
export type Trusted = { fromHeight: number; time: number; hash: string; members: Member[] };

export async function trustedSet(telos: RpcEndpoints, lightClient: string): Promise<Trusted | null> {
  const page = await antelopeRpc(telos, '/v1/chain/get_table_rows', {
    json: true, code: lightClient, scope: lightClient, table: 'trusted', limit: 1,
  });
  const row = page.rows?.[0];
  if (!row) return null;
  const addresses = String(row.addresses);
  const powers = (row.powers as (string | number)[]).map((p) => BigInt(p));
  return {
    fromHeight: Number(row.from_height),
    time: Number(row.time),
    hash: String(row.hash).toLowerCase(),
    // The commit builder needs addresses and powers in the set's order; the keys
    // themselves were checked once, when the set was installed.
    members: powers.map((power, i) => ({ address: addresses.slice(i * 40, i * 40 + 40), pubkey: '', power })),
  };
}

async function validatorsHashAt(chain: EvmChain, height: number): Promise<string> {
  const sh = (await comet(heimdallOf(chain), `commit?height=${height}`)).signed_header;
  return String(sh.header.validators_hash).toLowerCase();
}

/**
 * `proveroot` for a Bor block, under the trusted set.
 *
 * The milestone is read from the state at the newest height the trusted set
 * still signs. When the chain has moved to a set the client does not hold yet,
 * that is a refusal naming the cause — the relayer's `updateset` is what is
 * missing, not a proof.
 */
export async function proverootArgs(chain: EvmChain, telos: RpcEndpoints, lightClient: string, payer: string, block: number) {
  const h = heimdallOf(chain);
  const trusted = await trustedSet(telos, lightClient);
  if (!trusted) throw new Error(`${lightClient} holds no validator set; bootstrap it`);

  // q + 1 is the header whose app_hash carries the state at q; its commit is
  // canonical once q + 2 exists.
  const q = (await latestHeight(h)) - 3;
  if ((await validatorsHashAt(chain, q + 1)) !== trusted.hash) {
    throw new Error(`Heimdall moved to a validator set ${lightClient} does not hold yet; the relayer must updateset first`);
  }

  // The milestone whose range holds the block, and its successor (the contract's
  // two-milestone rule). A block in a fast-forward gap belongs to no range and
  // goes by the checkpoint path instead.
  const covering = await milestoneCovering(h, block);
  if (covering.start > block) {
    throw new Error(`Bor ${block} is in a fast-forward gap before milestone ${covering.number}; prove it through a checkpoint`);
  }
  const { args: proof, milestone, next } = await milestoneArgs(h, covering.number, q, trusted.members);
  const bor = await borChain(chain.exec, block, next.end);
  if (bor.topHash !== next.hash) throw new Error(`Bor ${next.end} is not the block milestone ${next.number} names`);
  return {
    args: [payer, proof, bor.rlp] as const,
    milestone,
    next,
    heimdallHeight: q + 1,
    signedBy: `${proof.commit.precommits.length}/${trusted.members.length}`,
  };
}

/** What is left to install, and the first step of it. */
export type SetStep = { args: { commit: unknown; next: unknown }; from: number; refresh: boolean } | null;

/**
 * The next `updateset`, or null when the client is current and young enough.
 *
 * Sets are installed in order: the first height at or after the trusted set's
 * range whose header names another set, found by bisection, and the header just
 * before it — which the trusted set signed and whose `next_validators_hash` is
 * the new set. With no change in sight, the same set is re-installed from a
 * recent header once `refreshAfter` seconds have passed, which keeps the trusting
 * period from running out under a set that simply has not moved.
 */
export async function nextSetStep(chain: EvmChain, trusted: Trusted, refreshAfter: number): Promise<SetStep> {
  const h = heimdallOf(chain);
  const top = (await latestHeight(h)) - 3;

  if ((await validatorsHashAt(chain, top)) === trusted.hash) {
    if (Date.now() / 1000 - trusted.time < refreshAfter) return null;
    const commit = await commitArgs(h, top, trusted.members);
    const next = await validatorSet(h, top + 1, commit.header.next_validators_hash);
    return { args: { commit, next: validatorArgs(next) }, from: top + 1, refresh: true };
  }

  // The first height past the trusted set: lo still under it, hi not.
  let lo = trusted.fromHeight, hi = top;
  if ((await validatorsHashAt(chain, lo)) !== trusted.hash) {
    throw new Error(`Heimdall ${lo}, where the trusted set starts, is not under it; the client needs a bootstrap`);
  }
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if ((await validatorsHashAt(chain, mid)) === trusted.hash) lo = mid; else hi = mid;
  }
  const commit = await commitArgs(h, lo, trusted.members);
  const next = await validatorSet(h, lo + 1, commit.header.next_validators_hash);
  return { args: { commit, next: validatorArgs(next) }, from: lo + 1, refresh: false };
}

/** `bootstrap` from a recent header: its commit, and the set that signed it. */
export async function bootstrapArgs(chain: EvmChain, height?: number) {
  const h = heimdallOf(chain);
  const at = height ?? (await latestHeight(h)) - 3;
  const header = (await comet(h, `commit?height=${at}`)).signed_header.header;
  const set = await validatorSet(h, at, header.validators_hash);
  const commit = await commitArgs(h, at, set);
  return { args: { commit, validators: validatorArgs(set) }, height: at, set };
}
