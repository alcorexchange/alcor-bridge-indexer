/**
 * Assembling a BSC proof: which validator set was in force, which vote finalized
 * the block, and the arguments `bsclightclnt` takes.
 *
 * Nothing here is trusted by the contract — it recomputes all of it. This module
 * exists so a failure on chain is a disagreement between two implementations
 * rather than a hunt through a proof nobody has looked at.
 */

import { evmChain } from '../chains/evm.ts';
import { fetchHeader, toHex, type EncodedHeader } from './header.ts';
import {
  parseAttestation,
  parseTurnLength,
  parseValidators,
  switchDelay,
  verifyAttestation,
  voteProofArgs,
  type Validator,
  type VoteAttestation,
} from './vote.ts';

export type ActiveSet = {
  /** The epoch block that announced this set. */
  epoch: number;
  /** The height it took effect. */
  activeFrom: number;
  set: Validator[];
};

function urlsOf(chain: string): { urls: string[]; epochLength: number } {
  const c = evmChain(chain);
  if (c.strategy !== 'parlia') throw new Error(`${chain} is not a Parlia chain`);
  if (!c.epochLength) throw new Error(`${chain} has no epochLength configured`);
  return { urls: c.exec, epochLength: c.epochLength };
}

/**
 * The set announced at `epoch`, and the first vote target it signs.
 *
 * Parlia switches to a set announced at epoch block E only after
 * (m/2 + 1)·turnLength blocks, with m and turnLength of the set still in force
 * at E — which is why the previous epoch header is fetched too. Inside that
 * window the older set is still the one signing, and a proof built against the
 * announced one fails with nothing to suggest why.
 */
async function setAt(urls: string[], epoch: number, epochLength: number): Promise<ActiveSet> {
  const [announced, previous] = await Promise.all([
    fetchHeader(urls, epoch),
    fetchHeader(urls, epoch - epochLength),
  ]);
  const inForce = parseValidators(previous.extraData).length;
  return {
    epoch,
    activeFrom: epoch + switchDelay(inForce, parseTurnLength(previous.extraData)),
    set: parseValidators(announced.extraData),
  };
}

/** The set that signs a vote whose target is `height`. */
export async function activeSet(chain: string, height: number): Promise<ActiveSet> {
  const { urls, epochLength } = urlsOf(chain);
  const epoch = Math.floor(height / epochLength) * epochLength;
  const candidate = await setAt(urls, epoch, epochLength);
  return height >= candidate.activeFrom ? candidate : setAt(urls, epoch - epochLength, epochLength);
}

export type FinalizingVote = {
  att: VoteAttestation;
  /** The header the vote was read out of. Not part of the proof. */
  carrier: number;
  /** The block being proved: the bottom of `chain`. */
  block: EncodedHeader;
  /**
   * `block` and its descendants up to the one the vote finalizes, oldest first.
   * One header when the vote finalizes `block` itself.
   */
  chain: EncodedHeader[];
  active: ActiveSet;
};

/** Unparseable extraData (no vote carried) reads as no vote, not as an error. */
function attestationIn(header: EncodedHeader): VoteAttestation | null {
  try {
    return parseAttestation(header.extraData);
  } catch {
    return null;
  }
}

/**
 * Find the vote that finalizes `block`, directly or through a descendant.
 *
 * A vote in header N names target N-1 and source N-2, so the one that finalizes B
 * normally sits in B+2. A missed vote breaks that: when B+1 carries none, nothing
 * ever names B as a source, and B is final only because a later block is. So the
 * search takes the first vote in the window that finalizes B or any block above
 * it, and proves B by the header chain up to that block — the light client checks
 * every parent link. It refuses a vote that merely justifies: only a target that
 * is its source's direct child finalizes anything.
 *
 * The carrying header is deliberately not verified. The signature covers the four
 * vote fields and nothing else, so which block the bytes were copied out of is
 * not part of the proof — which is also why an old deposit costs no more to prove
 * than a fresh one.
 */
export async function voteFinalizing(
  chain: string,
  height: number,
  lookahead = 8,
): Promise<FinalizingVote> {
  const { urls } = urlsOf(chain);
  const headers = new Map<number, EncodedHeader>();
  const header = async (n: number) => {
    if (!headers.has(n)) headers.set(n, await fetchHeader(urls, n));
    return headers.get(n)!;
  };

  for (let n = height + 2; n <= height + 2 + lookahead; n++) {
    const att = attestationIn(await header(n));
    if (!att || att.sourceNumber < height || att.targetNumber !== att.sourceNumber + 1) continue;

    const proved: EncodedHeader[] = [];
    for (let h = height; h <= att.sourceNumber; h++) proved.push(await header(h));
    const top = proved.at(-1)!;
    if (toHex(att.sourceHash) !== top.hash) {
      throw new Error(`vote in ${n} names ${toHex(att.sourceHash)}, block ${att.sourceNumber} is ${top.hash}`);
    }
    const active = await activeSet(chain, att.targetNumber);
    const check = verifyAttestation(att, active.set);
    if (!check.ok) {
      throw new Error(
        `the vote in ${n} does not verify against the set from epoch ${active.epoch} ` +
          `(${check.signers}/${active.set.length} signers, quorum ${check.quorum})`,
      );
    }
    return { att, carrier: n, block: proved[0], chain: proved, active };
  }
  throw new Error(`no vote finalizing block ${height} or a descendant in the ${lookahead + 1} headers after it`);
}

const chainArg = (vote: FinalizingVote) => vote.chain.map((h) => toHex(h.rlp).slice(2));

/** `proveroot` arguments, in the action's own order, ready for cleos. */
export async function proverootArgs(chain: string, payer: string, height: number) {
  const vote = await voteFinalizing(chain, height);
  return {
    args: [payer, chainArg(vote), voteProofArgs(vote.att, vote.active.set)],
    vote,
  };
}

/**
 * `updateset` arguments for an epoch header.
 *
 * Proved exactly like any other block, because that is all it is — the set it
 * announces is read out of the header the contract has just finalized. No payer:
 * the row is the contract's, and only the next epoch is ever accepted.
 */
export async function updatesetArgs(chain: string, epoch: number) {
  const { epochLength } = urlsOf(chain);
  if (epoch % epochLength !== 0) throw new Error(`${epoch} is not an epoch block`);
  const vote = await voteFinalizing(chain, epoch);
  return {
    args: [chainArg(vote), voteProofArgs(vote.att, vote.active.set)],
    vote,
    announces: parseValidators(vote.block.extraData).length,
  };
}

/**
 * `bootstrap` arguments: the epoch header whose set is installed on authority,
 * and the epoch header before it, whose set times the switch.
 */
export async function bootstrapArgs(chain: string, epoch: number) {
  const { urls, epochLength } = urlsOf(chain);
  if (epoch % epochLength !== 0) throw new Error(`${epoch} is not an epoch block`);
  const [previous, header] = await Promise.all([
    fetchHeader(urls, epoch - epochLength),
    fetchHeader(urls, epoch),
  ]);
  return {
    args: [toHex(previous.rlp).slice(2), toHex(header.rlp).slice(2)],
    set: parseValidators(header.extraData),
    turnLength: parseTurnLength(header.extraData),
    activeFrom:
      epoch + switchDelay(parseValidators(previous.extraData).length, parseTurnLength(previous.extraData)),
  };
}
