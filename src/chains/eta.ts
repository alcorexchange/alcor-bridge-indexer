/**
 * How long a crossing takes on each chain, and where the time goes.
 *
 * This exists because the API told everyone "~13 minutes" — Ethereum's finality,
 * written out by hand in three places — on routes where the true answer was two
 * seconds or three quarters of an hour. A wait shown to a user has to come from
 * the chain that user is actually crossing, so it is computed from the registry
 * and nowhere else.
 *
 * Every figure traces to a measurement, taken 2026-09-22 against live chains and
 * recorded beside the value it produced. The ones that could not be measured are
 * marked `measured: false` rather than rounded into looking like the others.
 *
 * The estimates are deliberately whole spans, not single numbers. Nothing here is
 * one number: a relayer's poll can fire immediately or a minute later, and an
 * epoch boundary can be missed. Handing a front end a single
 * value would be inventing a precision none of it has.
 */

import type { EvmChain } from './evm.ts';
import type { AntelopeChain, Span } from './antelope.ts';
import type { NearChain } from './near.ts';
import type { SuiChain } from './sui.ts';

const add = (...spans: Span[]): Span =>
  spans.reduce((a, b) => ({
    min: a.min + b.min,
    typical: a.typical + b.typical,
    max: a.max + b.max,
  }));

/**
 * How long a finished proof can sit before anyone pushes it.
 *
 * The relayer that pushes proofs polls once a minute, so a proof waits half that on
 * average and all of it at worst. It is part of every wait on both sides, and
 * leaving it out is what would make an otherwise honest estimate optimistic.
 * Anyone may push sooner — none of these actions takes privileged authority — so
 * this is the unattended figure, not a floor.
 */
const RELAY: Span = { min: 0, typical: 30, max: 60 };
const RELAY_WHAT = 'the relayer picks the finished proof up';

/**
 * Telos finality.
 *
 * Measured: the head ran two blocks — one second — ahead of the last irreversible
 * block. Savanna finalizes in a round, so this is a constant of the protocol
 * rather than a load-dependent number.
 */
const SAVANNA: Span = { min: 1, typical: 1, max: 2 };

/** An Ethereum epoch, seconds. */
const EPOCH = 32 * 12;

/** How long until a block on this chain is final enough to prove against. */
function finality(chain: EvmChain): { what: string; span: Span } {
  if (chain.strategy === 'milestone') {
    // Measured 2026-10-07: Bor's `finalized` tag 2.8 s behind the head (p90 5.2,
    // max 8.4), a milestone every ~2.3 s; the light client wants the block's
    // milestone and the next one, then the Heimdall commit carrying that state,
    // two Heimdall blocks of 1.2 s.
    return {
      what: `a Heimdall milestone over the block and the next one after it`,
      span: { min: 5, typical: 8, max: 20 },
    };
  }
  if (chain.strategy === 'parlia') {
    // Measured: the `finalized` tag ran ONE block behind the head on both BSC
    // networks, because a Parlia vote is only accepted once it finalizes its own
    // source. Seconds — which is the figure the API was replacing with thirteen
    // minutes of somebody else's chain.
    return {
      what: `${chain.name} votes finality into its own headers`,
      span: { min: 1, typical: 2, max: 5 },
    };
  }
  return {
    what: `${chain.name} must finalize the block`,
    // Two epochs, three when justification crosses a missed boundary. Measured
    // the same day: Sepolia sat 18.6 min behind its head, mainnet 16.6 — both
    // inside this span, and both well above the 12.8 min the nominal figure
    // suggests.
    span: { min: 2 * EPOCH, typical: 2.5 * EPOCH, max: 3 * EPOCH },
  };
}

export type EtaPart = { what: string; seconds: number };

export type Eta = {
  /** The one number a front end shows, seconds. */
  seconds: number;
  /** Fastest and slowest, seconds. */
  range: [number, number];
  /** Where the time goes, in the order it is spent. */
  parts: EtaPart[];
  /**
   * Whether these numbers were measured on this chain, or derived from something
   * adjacent to it. A front end need not care; anyone reading the endpoint to
   * decide whether to trust a number does.
   */
  measured: boolean;
  /** The same estimate as a person reads it. */
  human: string;
};

/** A duration a person reads: seconds under a minute and a half, then minutes. */
export function humanEta(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds)} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} min`;
  return `${(minutes / 60).toFixed(1)} h`;
}

function eta(parts: { what: string; span: Span }[], measured: boolean): Eta {
  const total = add(...parts.map((p) => p.span));
  return {
    seconds: Math.round(total.typical),
    range: [Math.round(total.min), Math.round(total.max)],
    parts: parts.map((p) => ({ what: p.what, seconds: Math.round(p.span.typical) })),
    measured,
    human: `about ${humanEta(total.typical)} (${humanEta(total.min)}–${humanEta(total.max)})`,
  };
}

/**
 * How long a deposit on this chain waits before it can be credited on Telos:
 * the chain's own finality, and the push.
 */
export function depositEta(chain: EvmChain): Eta {
  const own = finality(chain);
  return eta([{ what: own.what, span: own.span }, { what: RELAY_WHAT, span: RELAY }], true);
}

/**
 * How long a deposit on the fast path waits: the route's confirmations on top of
 * the block, and the push. Null where no route has one, or where finality comes
 * as soon — a fast proof then saves nobody anything.
 *
 * Measured 2026-10-26 on mainnet, from the bridge's own activity: Ethereum →
 * Telos deposits under the fast-path ceiling took 163–173 s (19 transfers, a
 * median of 170) — twelve 12-second slots and the relayer's half-minute. A
 * missed slot stretches a block, so the slowest case allows half as many again.
 */
export function depositFastEta(chain: EvmChain, confirmations: number): Eta | null {
  if (confirmations <= 0) return null;
  const blocks = confirmations * chain.blockTime;
  const fast = eta(
    [
      { what: `${confirmations} ${chain.name} blocks on top of the deposit`, span: { min: blocks, typical: blocks, max: blocks * 1.5 } },
      { what: RELAY_WHAT, span: RELAY },
    ],
    true,
  );
  return fast.seconds < depositEta(chain).seconds ? fast : null;
}

/**
 * How long a withdrawal takes, from the burn on Telos to tokens on this chain.
 *
 * Short everywhere, and for one reason: the slow half of a crossing is always
 * the chain being PROVED, and on this side that is Telos, which finalizes in a
 * second. What is left is a relayer's poll and one transaction.
 *
 * Null where the chain has no withdrawals contract — there is no route to
 * estimate.
 */
export function withdrawalEta(chain: EvmChain): Eta | null {
  if (!chain.withdrawals) return null;
  // One block to land, four when it is submitted just as a block closes and the
  // next one is full. Not a measurement of congestion, and not meant as one.
  const confirm: Span = {
    min: chain.blockTime,
    typical: chain.blockTime * 2,
    max: chain.blockTime * 4,
  };
  return eta(
    [
      { what: 'Telos must finalize the burn', span: SAVANNA },
      { what: RELAY_WHAT, span: RELAY },
      { what: `the release confirms on ${chain.name}`, span: confirm },
    ],
    true,
  );
}

/**
 * An Antelope chain → Telos.
 *
 * Legacy: the block is proved by two rounds of 2/3+1 producer signatures on top
 * of it (waxlightcl), then the relayer pushes the proof. WAX measured on mainnet
 * 2026-09-30: about fifty seconds from deposit to credit; the producers' share
 * is the chain's own (`confirm` in antelope.ts).
 *
 * Savanna: a strong certificate makes the block final in a second or two
 * (savannalc), then the relayer pushes the root and the credit together. Not
 * measured on mainnet yet, and marked so.
 */
export function antelopeDepositEta(chain: AntelopeChain): Eta {
  if (chain.consensus === 'savanna') {
    return eta(
      [
        { what: `${chain.name} finalizers certify the block`, span: chain.deposit.certify },
        { what: 'the relayer proves it on Telos', span: chain.deposit.prove },
      ],
      false,
    );
  }
  return eta(
    [
      { what: `${chain.name} producers build two rounds of 2/3+1 on top of the block`, span: chain.confirm },
      { what: 'the relayer proves it on Telos', span: { min: 3, typical: 8, max: 30 } },
    ],
    true,
  );
}

/**
 * Telos → an Antelope chain.
 *
 * Legacy: Telos finalizes the burn (a strong QC on it and one on that), 2/3+1
 * of the proposer policy build on the certificate (telosclient), then the
 * relayer releases it. Measured on mainnet 2026-09-30 for WAX: about two
 * minutes; only the last step is the far chain's.
 *
 * Savanna: the certificate itself is the proof (savannalc), so the two minutes
 * of producer rounds are gone; Telos finalizing and the relayer are all that is
 * left. Not measured on mainnet yet, and marked so.
 */
export function antelopeWithdrawalEta(chain: AntelopeChain): Eta {
  if (chain.consensus === 'savanna') {
    return eta(
      [
        { what: 'Telos finalizes the burn', span: chain.withdrawal.finalize },
        { what: `the relayer releases it on ${chain.name}`, span: chain.withdrawal.release },
      ],
      false,
    );
  }
  return eta(
    [
      { what: 'Telos finalizes the burn', span: { min: 1, typical: 2, max: 5 } },
      { what: '2/3+1 of Telos producers build on the certificate', span: { min: 80, typical: 90, max: 130 } },
      { what: `the relayer releases it on ${chain.name}`, span: { min: 3, typical: 15, max: 40 } },
    ],
    true,
  );
}

/** Sui → Telos: the checkpoint certified, then the relayer's proof on Telos. */
export function suiDepositEta(chain: SuiChain): Eta {
  return eta(
    [
      { what: `the ${chain.name} committee certifies the checkpoint`, span: chain.deposit.certify },
      { what: 'the relayer proves it on Telos', span: chain.deposit.prove },
    ],
    false,
  );
}

/** Telos → Sui: the burn finalized, then the recipient's own release. */
export function suiWithdrawalEta(chain: SuiChain): Eta {
  return eta(
    [
      { what: 'Telos finalizes the burn', span: chain.withdrawal.finalize },
      { what: `the wallet releases it on ${chain.name}`, span: chain.withdrawal.release },
    ],
    false,
  );
}

/** NEAR → Telos: the block final, then the relayer's head and proof on Telos. */
export function nearDepositEta(chain: NearChain): Eta {
  return eta(
    [
      { what: `${chain.name} finalizes the block`, span: chain.deposit.final },
      { what: 'the relayer proves it on Telos', span: chain.deposit.prove },
    ],
    false,
  );
}

/** Telos → NEAR: the burn finalized, then the recipient's own release. */
export function nearWithdrawalEta(chain: NearChain): Eta {
  return eta(
    [
      { what: 'Telos finalizes the burn', span: chain.withdrawal.finalize },
      { what: `the wallet releases it on ${chain.name}`, span: chain.withdrawal.release },
    ],
    false,
  );
}
