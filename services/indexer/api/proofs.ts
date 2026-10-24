/**
 * `/v1/proofs/<key>`: everything needed to finish a crossing, in the shape the
 * chain takes. Deposit and void proofs pushed on the settlement chain, and a
 * withdrawal's release on its EVM chain; Sui and NEAR releases are in their own
 * files.
 */

import { EVM_CHAINS, TOPICS } from '../../../src/chains/evm.ts';
import { proverootPositional } from '../../../src/proofs.ts';
import { proverootArgs as polygonProveroot } from '../../../src/polygon/proof.ts';
import { rebranch } from '../../../src/savanna/rebranch.ts';
import type { WithdrawalArtifact } from '../../../src/savanna/withdrawalArtifact.ts';
import { frozenSubmitRoot } from '../../../src/savanna/withdrawalProof.ts';
import { SETTLEMENT_CHAIN, chainOfDomain, type Domain } from '../config.ts';
import { BOOKED, withdrawalKey, type TransferRow } from '../db.ts';
import { buildFast, FastUnavailable } from '../fast.ts';
import { inWindow, proofWait, rootCovering, type Deps } from './deps.ts';
import { fail, pattern, type Reply, type Route } from './http.ts';
import { nearWithdrawalProof } from './near.ts';
import { suiWithdrawalProof } from './sui.ts';

/** A domain this instance follows as an EVM source. */
type EvmDomain = Extract<Domain, { kind: 'evm' }>;

export const proofRoutes: Route[] = [
  {
    shown: '/v1/proofs/<key>',
    match: pattern(/^\/v1\/proofs\/(.+)$/),
    handle: ({ deps, params: [key] }) => proof(deps, key),
  },
];

/** A proof pushed on the settlement chain: a deposit's credit, or a void's refund. */
type SettledKind = 'deposit' | 'void';

/**
 * Everything needed to finish a crossing, in the shape the chain takes.
 *
 * For a withdrawal that is two possible answers, and the choice is made here
 * rather than by the caller:
 *
 *   light   fold into a root somebody already made trusted — one transaction,
 *           ~135k gas. Offered only when the branch was rebuilt and checked.
 *   hard    submit this withdrawal's own root first, then release — ~2.6M gas.
 *           Always available, because the artifact carries both halves.
 *
 * For a deposit or a void it is one answer per proof strategy, each below. This
 * function only finds the row the proof belongs to — which is where its chain is
 * recorded — and picks.
 */
async function proof(deps: Deps, key: string): Promise<Reply> {
  const stored = deps.store.getProof(key);
  const row = transferOf(deps, key, stored?.kind);
  if (!row) return fail(404, 'NOT_FOUND', 'no such transfer');
  if (!stored) return proofOnDemand(deps, row);
  if (stored.kind === 'withdrawal') {
    const artifact = JSON.parse(stored.body);
    const far = chainOfDomain(deps.cfg, row.domain);
    if (far?.kind === 'sui') return suiWithdrawalProof(deps, row, artifact);
    if (far?.kind === 'near') return nearWithdrawalProof(deps, row, artifact);
    return withdrawalProof(deps, row, artifact);
  }

  const kind = stored.kind as SettledKind;
  const body = JSON.parse(stored.body);
  const source = chainOfDomain(deps.cfg, row.domain);
  if (source?.kind !== 'evm') {
    return fail(404, 'NOT_FOUND', `domain ${row.domain} is not a source chain this instance follows`);
  }
  if (body.strategy === 'milestone') return milestoneProof(deps, key, kind, row, source, body);
  if (body.strategy === 'parlia') return parliaProof(deps, key, kind, source, body);
  return beaconProof(deps, key, kind, row, source, body);
}

/**
 * The transfer a proof belongs to, which is where its chain is recorded.
 *
 * A void is proved under `v:<id>` but has no row of its own: it rolls back the
 * withdrawal `w:<id>`. Looked up under its own key it found nothing, the chain
 * came out unknown, and the Ethereum contracts were named instead — right for a
 * Sepolia void by accident, and a BSC void was sent to `ethlightclnt`.
 */
function transferOf(deps: Deps, key: string, kind: string | undefined) {
  return deps.store.getTransfer(kind === 'void' ? withdrawalKey(key.slice(2)) : key);
}

/** What every settlement-chain proof starts with. */
const proofHead = (key: string, kind: SettledKind, blockNumber: number) => ({
  key,
  kind,
  direction: kind === 'deposit' ? 'deposit' : 'withdrawal-rollback',
  pushOn: SETTLEMENT_CHAIN,
  blockNumber,
});

/**
 * The gateway action a proof ends with. Same machinery, same argument shape;
 * only the action differs: `credit` turns a Deposit log into wrapped tokens,
 * `voided` turns a Voided log into a refund of what was burned, and the `cp`
 * pair takes either through a Polygon checkpoint instead of a milestone.
 */
function gatewayAction(kind: SettledKind, viaCheckpoint: boolean): string {
  if (viaCheckpoint) return kind === 'deposit' ? 'creditcp' : 'voidedcp';
  return kind === 'deposit' ? 'credit' : 'voided';
}

/**
 * Nothing frozen yet — but a deposit's fast proof is built on demand and is
 * available ten minutes before the finalized one exists. That window is the
 * whole point of the fast path, so 404 would be the wrong answer in it.
 */
async function proofOnDemand(deps: Deps, row: TransferRow): Promise<Reply> {
  if (row.direction !== 'deposit' || BOOKED.includes(row.status)) {
    return fail(404, 'PROOF_NOT_READY', 'no proof stored for this transfer yet', { status: row.status });
  }
  const fast = await fastPart(deps, row, 'credit');
  if (!fast.fast) {
    return fail(404, 'PROOF_NOT_READY', 'no proof available yet', { status: row.status, fastUnavailable: fast.fastUnavailable ?? null });
  }
  return {
    code: 200,
    body: {
      ...proofHead(row.key, 'deposit', row.src_block),
      ...fast,
      // Per chain, not thirteen minutes: the same sentence used to quote
      // Ethereum's finality at someone depositing on BSC, where it is seconds.
      finalizedPending: `the finalized proof is frozen once the block finalizes — ${proofWait(deps, row)}`,
    },
  };
}

/**
 * Polygon, built here, now: its Heimdall commit has to be from the exact set
 * polylightcl holds at the moment it is pushed, and that set moves about
 * hourly. Only the receipt was frozen.
 */
async function milestoneProof(
  deps: Deps, key: string, kind: SettledKind, row: TransferRow, source: EvmDomain, body: any,
): Promise<Reply> {
  const gateway = withPayer(deps, body.gateway);
  try {
    const built = await polygonProveroot(source.chain, deps.cfg.savanna, source.accounts.lightClient, payerFor(deps, body.gateway[0]), body.blockNumber);
    return {
      code: 200,
      body: {
        ...proofHead(key, kind, body.blockNumber),
        track: 'finalized',
        finalized: {
          note: 'built now, under the validator set the light client holds; push it soon — the set moves about hourly',
          signedBy: built.signedBy,
          milestone: built.milestone.number,
          heimdallHeight: built.heimdallHeight,
          actions: [
            { account: source.accounts.lightClient, name: 'proveroot', data: [...built.args] },
            { account: source.accounts.gateway, name: gatewayAction(kind, false), data: gateway },
          ],
        },
      },
    };
  } catch (err) {
    return fail(404, 'PROOF_NOT_READY', 'no proof available yet', { status: row.status, reason: (err as Error).message });
  }
}

/**
 * A Parlia proof carries its own keys — all of the epoch's set, in two
 * kilobytes — so there is no committee to stitch back in, and no fast track to
 * attach: every row its light client writes is already final.
 */
function parliaProof(deps: Deps, key: string, kind: SettledKind, source: EvmDomain, body: any): Reply {
  return {
    code: 200,
    body: {
      ...proofHead(key, kind, body.blockNumber),
      track: 'finalized',
      finalized: {
        note: 'BSC finalizes in about a second; this proof is final and cannot go stale',
        signedBy: body.signedBy,
        epoch: body.epoch,
        finalizedBy: body.finalizedBy,
        actions: [
          { account: source.accounts.lightClient, name: 'proveroot', data: withPayer(deps, body.proveroot) },
          { account: source.accounts.gateway, name: gatewayAction(kind, false), data: withPayer(deps, body.gateway) },
        ],
      },
    },
  };
}

/**
 * A sync-committee proof: Ethereum's own, or a Polygon checkpoint proved through
 * Ethereum's state. The committee is stored once per period and stitched back in
 * here.
 *
 * A Polygon deposit the milestone path did not close carries a checkpoint proof
 * (audit P-4): proved on the light client of the chain Polygon settles to, and
 * credited by the Polygon gateway's checkpoint action.
 */
async function beaconProof(
  deps: Deps, key: string, kind: SettledKind, row: TransferRow, source: EvmDomain, body: any,
): Promise<Reply> {
  const committee = deps.store.getCommittee(body.committeePeriod);
  if (!committee) {
    return fail(500, 'INTERNAL_ERROR', `committee for period ${body.committeePeriod} is missing from storage`);
  }
  const viaCheckpoint = body.fallback === 'checkpoint';
  const lightClient = viaCheckpoint
    ? deps.cfg.sources.find((s) => s.chain.id === source.chain.settlesTo)?.accounts.lightClient
    : source.accounts.lightClient;
  if (!lightClient) {
    return fail(500, 'INTERNAL_ERROR', `${source.chain.id} settles to ${source.chain.settlesTo}, which this instance does not follow`);
  }
  const action = gatewayAction(kind, viaCheckpoint);
  const pr = { ...body.proveroot, keys: committee.keys, agg_key: committee.agg_key };
  return {
    code: 200,
    body: {
      ...proofHead(key, kind, body.blockNumber),
      track: 'finalized',
      finalized: {
        note: 'the chain can no longer abandon this block; never goes stale',
        signedBy: body.signedBy,
        ancestryHeaders: body.ancestry ?? null,
        actions: antelopeActions(deps, pr, body.gateway, action, { lightClient, gateway: source.accounts.gateway }),
      },
      // And the fast one, built now rather than read: an optimistic proof bakes
      // in its depth, so a stored one is worthless the moment a route asks for more.
      ...(await fastPart(deps, row, action)),
    },
  };
}

/** A withdrawal's release on its EVM chain: the hard track always, the light one when a trusted root folds it. */
function withdrawalProof(deps: Deps, row: TransferRow, artifact: WithdrawalArtifact): Reply {
  const target = settlementTarget((artifact.release as any)?.domain, artifact.vault);
  const out = {
    key: row.key,
    direction: 'withdrawal',
    // Null, with the warning, for a chain this build cannot name: labelling it
    // with this instance's own chain sent a front end to the wrong network.
    chain: target.id,
    ...(target.unknown ? { warning: target.unknown } : {}),
    burnBlock: artifact.burnBlock,
    rootBlock: artifact.rootBlock,
    vault: artifact.vault,
    status: row.status,
    deadline: row.deadline,
    hard: {
      gas: '~2.4M + 176k',
      // Two calls to two contracts, so both addresses travel with the proof: a
      // front end that had to hardcode one of them would hardcode the wrong one
      // the next time either is redeployed.
      submitRootTo: target.lightClient,
      releaseTo: target.withdrawals,
      submitRoot: frozenSubmitRoot(artifact.submitRoot),
      release: artifact.release,
    },
  };

  const covering = rootCovering(deps, row, artifact.burnBlock);
  if (!covering) return { code: 200, body: { ...out, track: 'hard', lightUnavailable: 'no trusted root covers this burn yet' } };
  if (!inWindow(deps, covering.block)) {
    return {
      code: 200,
      body: { ...out, track: 'hard', lightUnavailable: `leaves for block ${covering.block} are outside the retained window` },
    };
  }
  try {
    const moved = rebranch(deps.cfg.savanna, deps.cfg.checkpointDir, deps.savanna.leafStore, artifact, covering);
    return {
      code: 200,
      body: {
        ...out,
        light: {
          gas: '~135k',
          note: 'folds into a root already trusted on the far side; no submitRoot needed',
          rootBlock: covering.block,
          releaseTo: target.withdrawals,
          release: { ...artifact.release, ...moved },
        },
        track: 'light',
      },
    };
  } catch (err) {
    // Never serve a branch that did not fold. Falling back to the artifact is
    // more expensive and always correct.
    return { code: 200, body: { ...out, lightUnavailable: (err as Error).message, track: 'hard' } };
  }
}

/**
 * Where a withdrawal settles, taken from the withdrawal rather than from this
 * process's configuration.
 *
 * The Telos half of an instance is shared by every route: it follows one bridge
 * contract, and that contract's withdrawal table holds crossings bound for every
 * chain there is a route to. So one Savanna follower serves them all — nothing
 * about a finality proof is chain-specific — and the only per-chain facts are the
 * two addresses the proof is pushed to.
 *
 * Reading those off `cfg.evm` was the bug: an instance configured for Sepolia
 * labelled a BSC withdrawal with Sepolia's verifier. The proof was right, the
 * envelope was wrong, and the wrong envelope is the kind that reverts far away
 * from the mistake — or, on a chain that happens to have a contract at the same
 * address, does not revert at all.
 */
function settlementTarget(domain: number | string | undefined, vault?: string) {
  const chainId = Number(domain);
  const chain = Object.values(EVM_CHAINS).find((c) => c.chainId === chainId);
  // A withdrawal names its vault, and only that vault's releaser accepts it. One
  // burned before a vault was replaced belongs to the old one, which the
  // registry no longer points at: say so rather than hand out a doomed call.
  const otherVault = chain?.vault && vault && chain.vault.toLowerCase() !== vault.toLowerCase();
  return {
    id: chain?.id ?? null,
    chainId: Number.isSafeInteger(chainId) ? chainId : null,
    lightClient: chain?.lightClient ?? null,
    withdrawals: chain?.withdrawals ?? null,
    /** Set when this build cannot say where the proof settles. */
    unknown: !chain
      ? `no chain with id ${domain} in the registry`
      : otherVault
        ? `withdrawal is for vault ${vault}; the registry's vault on this chain is ${chain!.vault}`
        : undefined,
  };
}

/**
 * Who a served proof names as its payer.
 *
 * `PROOF_PAYER` when the deployment set one, otherwise whoever the proof was built
 * for. The substitution happens here rather than at freezing time on purpose: a
 * stored artifact stays valid when the deployment changes its mind about which
 * account pays, and the payer is only ever an argument — nothing in the proof is
 * bound to it.
 */
function payerFor(deps: Deps, baked: string): string {
  return deps.cfg.proofPayer ?? baked;
}

/** Positional action arguments, payer first, with the payer `payerFor` names. */
const withPayer = (deps: Deps, args: unknown[]): unknown[] => [payerFor(deps, String(args[0])), ...args.slice(1)];

/** The two actions an Antelope-side proof always comes as, in argument order. */
function antelopeActions(
  deps: Deps,
  pr: any,
  gateway: any,
  gatewayAction: string,
  accounts: { lightClient: string; gateway: string },
): unknown[] {
  return [
    {
      account: accounts.lightClient,
      name: 'proveroot',
      data: [
        ...proverootPositional({ ...pr, payer: payerFor(deps, pr.payer) }),
      ],
    },
    {
      account: accounts.gateway,
      name: gatewayAction,
      // Two shapes, because two gateways take different arguments. Ethereum's
      // `credit` takes five and is stored as a named object; Polygon's
      // `creditcp` takes eight — the checkpoint and the Bor block ride along — and
      // is stored positionally, in the action's own order. An array is passed
      // through with only the payer substituted, so adding a gateway later
      // means adding arguments and nothing here.
      data: Array.isArray(gateway)
        ? withPayer(deps, gateway)
        : [payerFor(deps, gateway.payer), gateway.block_hash, gateway.key, gateway.nodes, gateway.log_index],
    },
  ];
}

/** The fast half of a deposit's proof: the proof and its track, or why there is none. */
type FastPart = { track?: 'fast'; fast?: Record<string, unknown>; fastUnavailable?: string };

/**
 * The fast proof, if the route allows one and the depth is there.
 *
 * Failure here is a normal answer, not an error: "eight of twelve confirmations"
 * is what a UI should show, and the finalized half is already in hand.
 */
async function fastPart(deps: Deps, row: TransferRow, gatewayAction: string): Promise<FastPart> {
  if (row.direction !== 'deposit' || !row.src_tx || !row.token || !row.amount) return {};

  const source = chainOfDomain(deps.cfg, row.domain);
  if (!source) return { fastUnavailable: `domain ${row.domain} is not a source chain this instance follows` };
  if (source.kind !== 'evm') {
    return { fastUnavailable: `${source.chain.name} deposits are proved by its relayer; there is no fast track to offer` };
  }
  // A fast proof is a beacon-chain idea: a committee-signed head plus a proved
  // confirmation depth. A Parlia route has no such thing to offer — its light
  // client accepts a vote only when it finalizes its source, so every proof it
  // takes is already final and the finalized track is the only one.
  if (source.chain.strategy !== 'beacon') {
    return { fastUnavailable: `${source.chain.id} finalizes in seconds; there is no fast track to offer` };
  }
  // And it is built live against the active chain's endpoints, so a beacon chain
  // this process is not configured for cannot be served one either.
  if (source.chain.id !== deps.cfg.evm.id) {
    return { fastUnavailable: `fast proofs for ${source.chain.id} are built by the instance that follows it` };
  }

  try {
    const fast = await buildFast(deps.cfg, {
      txHash: row.src_tx,
      blockNumber: row.src_block,
      topic0: TOPICS.deposit,
      amount: BigInt(row.amount),
      extToken: row.token,
      domain: String(source.chain.chainId),
    });
    return {
      track: 'fast',
      fast: {
        note:
          `${fast.confirmations} confirmations proved, ${fast.required} required — ` +
          `credited now instead of waiting for finality`,
        confirmations: fast.confirmations,
        required: fast.required,
        signedBy: fast.signedBy,
        actions: antelopeActions(deps, fast.proveroot, fast.credit, gatewayAction, source.accounts),
      },
    };
  } catch (err) {
    return { fastUnavailable: err instanceof FastUnavailable ? err.message : `could not be built: ${(err as Error).message}` };
  }
}
