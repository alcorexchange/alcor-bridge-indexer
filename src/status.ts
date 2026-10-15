/**
 * The three numbers that say whether the bridge can still prove what it owes.
 *
 * Each one maps to an incident that already happened, and none of them is
 * visible from any single place today:
 *
 *   tree lag          the finality tree fell three days behind, so a withdrawal
 *                     could not be proved without first rebuilding it
 *   committee lag     the sync committee fell three periods behind, so a deposit
 *                     failed with "no sync committee stored for the period this
 *                     proof is from"
 *   unfrozen burns    a burn with no artifact is provable only while the node
 *                     still holds both halves of its proof, and the shorter half
 *                     is eight days
 *
 * They are computed here rather than in the daemon because they are also the
 * daemon's acceptance test: a process that claims to keep the tree at the head
 * is checked by something that does not share its idea of where the head is.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { SavannaChain } from './chains/savanna.ts';
import type { EvmChain } from './chains/evm.ts';
import { antelopeRpc, getInfo, getTableRows } from './net/antelope.ts';
import { execFor, selector } from './evm/exec.ts';
import { readFrontier } from './savanna/frontier.ts';
import { BeaconClient, periodOfSlot } from './evm/beacon.ts';

/**
 * State-history retention, measured by asking the node for the oldest block each
 * log answers for — not read from a config file, which describes intent rather
 * than what survived the last restart.
 *
 * A withdrawal proof needs both halves, so the binding number is eight.
 */
export const FINALITY_DATA_DAYS = 8;
export const TRACE_HISTORY_DAYS = 36;

const DAY_MS = 86_400_000;

// --- the finality tree ---------------------------------------------------------

export type TreeStatus = {
  lastBlock: number;
  leaves: number;
  head: number;
  lagBlocks: number;
  lagSeconds: number;
  /** Roots the chain disagreed with. Anything but zero poisons every later root. */
  mismatches: number;
};

export async function treeStatus(chain: SavannaChain, stateFile: string): Promise<TreeStatus> {
  // `readFrontier` re-folds the frontier and refuses one that recorded a
  // mismatch, so this reports a broken tree by throwing rather than by printing
  // a reassuring lag next to a root nobody agrees with.
  const { frontier } = readFrontier(stateFile);
  const head = (await getInfo(chain)).head_block_num;
  const lagBlocks = head - frontier.last_block;
  return {
    lastBlock: frontier.last_block,
    leaves: frontier.leaves,
    head,
    lagBlocks,
    lagSeconds: (lagBlocks * chain.blockIntervalMs) / 1000,
    mismatches: frontier.mismatches ?? 0,
  };
}

// --- the Ethereum sync committee ------------------------------------------------

export type CommitteeStatus = {
  /** Newest period the light client holds. */
  stored: number;
  /** Period the beacon chain is in now. */
  head: number;
  /** Periods behind. One is routine; two is an incident. */
  lagPeriods: number;
  /** Every period on file, for spotting a hole rather than a lag. */
  periods: number[];
};

/**
 * How far the light client is behind the committee currently signing.
 *
 * This is the one metric with no forgiving side. `updcommit` requires
 * `period == newest + 1`, because a committee is only provable by the one
 * before it, so a client that falls behind cannot jump — and once beacon nodes
 * have pruned the intervening `light_client/updates`, the only way back is a
 * re-bootstrap on authority, which is the single trusted act the rest of the
 * design exists to remove.
 */
export async function committeeStatus(
  chain: SavannaChain,
  beacon: BeaconClient,
): Promise<CommitteeStatus> {
  const rows = await getTableRows<{ period: number }>(chain, {
    code: chain.accounts.lightClient,
    table: 'roots',
  });
  if (!rows.length) {
    throw new Error(`${chain.accounts.lightClient} holds no committee at all — bootstrap first`);
  }
  const periods = rows.map((r) => Number(r.period)).sort((a, b) => a - b);
  const stored = periods[periods.length - 1];
  const head = periodOfSlot(Number((await beacon.optimisticUpdate()).attested_header.beacon.slot));
  return { stored, head, lagPeriods: head - stored, periods };
}

// --- finalizer policy on the EVM side --------------------------------------------

/**
 * Generations behind at which a lagging light client is an alarm, not a rotation.
 *
 * A withdrawal verifies against whoever signed its certificate, with the
 * threshold counted over the seats the light client holds: 15 of 21. A rotation
 * moves at most two seats, so `lag` generations behind the guaranteed overlap is
 * 21 - 2*lag — 17 at two, 15 at three, the bare threshold, where one absent
 * signer fails the proof. Two is routine; three is the alarm.
 */
export const POLICY_LAG_ALARM = 3;

export type PolicyStatus = { chain: string; held: number; active: number; lag: number };

/**
 * How many finalizer generations each EVM `TelosLightClient` trails Telos by.
 *
 * `submitRoot` accepts a quorum of the policy it holds, however old that policy
 * is. Telos rotates twice a day, so every generation a client falls behind adds
 * former finalizers who could, together, sign a root that never existed. One
 * behind is a rotation `advance-policy` has yet to follow; two means nothing is
 * following, and a growing number is a reason to halt that chain's vault.
 */
export async function policyStatus(chain: SavannaChain, evm: EvmChain[]): Promise<PolicyStatus[]> {
  const info = await antelopeRpc(chain, '/v1/chain/get_finalizer_info');
  const active = Number(info.active_finalizer_policy.generation);
  return Promise.all(
    evm.map(async (c) => {
      const word = await execFor(c.exec).rpc('eth_call', [
        { to: c.lightClient, data: selector('policyGeneration()') },
        'latest',
      ]);
      const held = Number(BigInt(word));
      return { chain: c.id, held, active, lag: active - held };
    }),
  );
}

// --- frozen artifacts -----------------------------------------------------------

/** Where a burn's frozen proof lives. The one place this convention is written. */
export const artifactPath = (dir: string, burnBlock: number): string =>
  join(dir, `withdrawal-${burnBlock}.json`);

/** `wdraws` rows: 0 open, 1 released, 2 refunded. */
export const WITHDRAWAL_OPEN = 0;

export type BurnStatus = {
  id: number;
  blockNum: number;
  /** When the burn happened, from the row rather than from a block header. */
  at: Date;
  frozen: boolean;
  /** When the node stops holding the finality half of this burn's proof. */
  provableUntil: Date;
  /** Negative once the live node can no longer supply the proof. */
  daysLeft: number;
};

/**
 * Every open withdrawal, and whether its proof has been frozen.
 *
 * The inventory comes from `wdraws`, not from a history API: the row carries
 * `block_num` precisely so a proof stays recoverable, which makes the contract
 * itself the authority on what is owed. An indexer that asked Hyperion instead
 * would be trusting a service the bridge does not otherwise depend on.
 *
 * Settled withdrawals are left out. Their artifacts are dead weight the moment
 * `Released` or `Voided` lands, which is the one thing that keeps steady-state
 * storage flat.
 */
export async function openBurns(chain: SavannaChain, artifactDir: string): Promise<BurnStatus[]> {
  const rows = await getTableRows<{
    id: number;
    status: number;
    block_num: number;
    at: string;
  }>(chain, { code: chain.accounts.bridge, table: 'wdraws' });

  return rows
    .filter((r) => Number(r.status) === WITHDRAWAL_OPEN)
    .map((r) => {
      // `time_point` comes back without a zone and is UTC.
      const at = new Date(r.at + 'Z');
      const provableUntil = new Date(at.getTime() + FINALITY_DATA_DAYS * DAY_MS);
      return {
        id: Number(r.id),
        blockNum: Number(r.block_num),
        at,
        frozen: existsSync(artifactPath(artifactDir, Number(r.block_num))),
        provableUntil,
        daysLeft: (provableUntil.getTime() - Date.now()) / DAY_MS,
      };
    })
    .sort((a, b) => a.id - b.id);
}
