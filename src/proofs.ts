/**
 * Turning a proof bundle into the two actions that consume it.
 *
 * The split mirrors the contracts: consensus is proved once per Ethereum block
 * to the light client, and each deposit in that block is then claimed cheaply
 * through the gateway. Both can ride in one transaction — inside a transaction
 * state is applied in order, so the gateway sees the row the light client just
 * wrote — which keeps it a single click for a user while still paying for the
 * expensive half only once per block.
 */

import { bare } from './proof/hex.ts';
import type { ProofBundle } from './evm/proofBundle.ts';

/** `ethlightclnt::proveroot` — the expensive half, once per Ethereum block. */
export function proverootArgs(bundle: ProofBundle, payer: string) {
  const e = bundle.event;
  return {
    payer,
    signed_header: e.signed_header,
    sig: bare(bundle.bls.sigHex),
    bits: bare(bundle.bls.bitsHex),
    /**
     * All 512 committee keys, ~49 KB.
     *
     * The contract stores only the committee's SSZ root and re-derives it from
     * whatever it is handed, so carrying the keys is what lets a proof of any age
     * stay verifiable without the chain keeping 49 KB per period forever.
     * Against Telos's 600 KB transaction limit it is affordable; it is the single
     * largest thing in the transaction.
     */
    keys: bare(bundle.committee.keysHex),
    agg_key: bare(bundle.committee.aggKeyHex),
    finalized: e.finalized,
    finality_branch: e.finality_branch.map(bare),
    ancestry: e.ancestry,
    receipts_root: bare(e.receiptsRootHex),
    receipts_branch: e.receiptsBranch.map(bare),
    block_number: e.blockNumber,
    number_branch: e.numberBranch.map(bare),
    block_hash: bare(e.blockHashHex),
    hash_branch: e.hashBranch.map(bare),
    exec_branch: e.execBranch.map(bare),
    state_root: bare(e.stateRootHex),
    state_branch: e.stateBranch.map(bare),
  };
}

/**
 * The same arguments in the order the action declares them.
 *
 * cleos and the RPC both want a positional array, and every caller used to build
 * that array by hand. One of them left `ancestry` out — a fifteen-element array
 * for a sixteen-argument action, which fails at the node with a message about
 * counts rather than about the missing field. Appending a field to `proveroot`
 * would have broken all of them the same silent way, so the order lives here
 * once and nowhere else.
 */
export function proverootPositional(args: ReturnType<typeof proverootArgs>) {
  return [
    args.payer, args.signed_header, args.sig, args.bits, args.keys, args.agg_key,
    args.finalized, args.finality_branch, args.ancestry,
    args.receipts_root, args.receipts_branch,
    args.block_number, args.number_branch,
    args.block_hash, args.hash_branch,
    args.exec_branch,
    args.state_root, args.state_branch,
  ];
}

/**
 * `ethgateway11::credit` — the cheap half, once per deposit.
 *
 * Addressed by block hash rather than block number: after a reorg a number names
 * a different block, and this is the key the light client filed the row under.
 */
export function creditArgs(bundle: ProofBundle, payer: string) {
  return {
    payer,
    block_hash: bare(bundle.event.blockHashHex),
    key: bare(bundle.mpt.keyHex),
    nodes: bundle.mpt.nodesHex.map(bare),
    log_index: bundle.mpt.logIndex,
  };
}

/**
 * Roughly how much of the transaction limit a proof occupies.
 *
 * Worth having as a number rather than an intuition: Telos allows 600 KB per
 * transaction and the committee blob alone is about 49 KB, so it is the one part
 * of the design with a hard ceiling anywhere near it.
 */
export function proofSizeBytes(bundle: ProofBundle): { committee: number; total: number } {
  const args = proverootArgs(bundle, 'x');
  const hexLen = (s: string) => Math.ceil(s.length / 2);
  const committee = hexLen(args.keys) + hexLen(args.agg_key);
  const branches =
    [
      args.receipts_branch,
      args.number_branch,
      args.hash_branch,
      args.exec_branch,
      args.state_branch,
      args.finality_branch,
    ].reduce((n, b) => n + b.length * 32, 0) + hexLen(args.sig) + hexLen(args.bits);
  const mpt = bundle.mpt.nodesHex.reduce((n, h) => n + hexLen(h), 0);
  return { committee, total: committee + branches + mpt };
}
