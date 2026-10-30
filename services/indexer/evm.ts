/**
 * Following the EVM side: deposits in, settlements back, and which roots are
 * already trusted.
 *
 * ## What is perishable here, and what is not
 *
 * The committee's signature over a beacon head is *not* perishable: it travels
 * in the body of the next beacon block and stays there, so `updateFromBlocks`
 * rebuilds an old optimistic update from two block fetches. That is why this
 * does not run a live capture loop, and why the head-signature cache the
 * predecessor carried is not used.
 *
 * What is perishable is the execution side. Public nodes prune receipts within
 * days and then answer `eth_getTransactionReceipt` with `null`, which reads
 * exactly like "no such deposit". So a deposit's proof is frozen once its block
 * is finalized, and after that the crossing no longer depends on anyone's
 * retention.
 *
 * ## Three contracts
 *
 *   vault        `Deposit` — a crossing begins; `Released`/`Voided` — one ends
 *   withdrawals  `Expired` — a burn rolled back. Its `Released` is the vault's
 *                event repeated and is ignored, or every settlement lands twice
 *   lightClient  `RootAccepted` — a root that any later withdrawal may fold into
 *
 * The last one is what makes the cheap settlement track possible, so it is
 * followed as carefully as the money.
 */

import type { IndexerConfig, Source } from './config.ts';
import { BOOKED, Store, depositKey, voidKey, withdrawalKey } from './db.ts';

import { BeaconClient } from '../../src/evm/beacon.ts';
import { updateFromBlocks, slotForTimestamp, ancestryOfLength } from '../../src/evm/fromBlocks.ts';
import { buildProofBundle } from '../../src/evm/proofBundle.ts';
import { CheckpointProver } from './checkpoint.ts';
import { RetryLater } from './retryLater.ts';
import { FailureStreak, GAP_MS } from './streak.ts';
import { ParliaProver } from '../../src/bsc/parlia.ts';
import { MilestoneProver } from './milestone.ts';
import type { Frozen, LogToFreeze, Prover } from '../../src/proof/prover.ts';
import { execFor, selector, type Exec } from '../../src/evm/exec.ts';
import { evmChain, TOPICS, type EvmChain } from '../../src/chains/evm.ts';
import { proverootArgs, creditArgs } from '../../src/proofs.ts';
import { uint64ToName } from '../../src/proof/pack.ts';

/** Seconds a Polygon deposit waits on the milestone path before the checkpoint path is tried. */
const MILESTONE_FALLBACK_AFTER = Number(process.env.MILESTONE_FALLBACK_AFTER ?? 1800);

/** Logs per request. Public nodes refuse wide ranges, and refuse them differently. */
const LOG_SPAN = 2_000;

/**
 * One node answering `eth_blockNumber` and another, a block behind it, answering
 * `eth_getLogs`: what a single load-balanced URL does several times an hour.
 * The range is simply asked for again on the next poll.
 */
const HEAD_RACE = /beyond current head|exceeds the latest block|after latest block/i;

/**
 * The settled check only tidies statuses the poller missed, once a minute: a
 * pruned or lagging upstream (`missing trie node`) costs it nothing but a pass.
 * Filed when it has not worked for half an hour.
 */
const SETTLED_LASTING_MS = 30 * 60_000;
/** Longer than a slow pass, whose history searches can take minutes. */
const SETTLED_GAP_MS = 15 * 60_000;

/** The address in the low twenty bytes of a word: a topic, or what `eth_call` returned. */
const addressFromWord = (w: string) => '0x' + w.slice(-40).toLowerCase();

const word = (data: string, i: number) => '0x' + data.slice(2 + i * 64, 2 + (i + 1) * 64);

/** The dynamic `bytes` whose offset sits in head word `i`, decoded as UTF-8. */
const bytesAt = (data: string, i: number): string => {
  const offset = Number(BigInt(word(data, i)));
  const len = Number(BigInt('0x' + data.slice(2 + offset * 2, 2 + offset * 2 + 64)));
  const start = 2 + (offset + 32) * 2;
  return Buffer.from(data.slice(start, start + len * 2), 'hex').toString('utf8');
};

export type EvmState = {
  at: number;
  head: number;
  caughtUp: boolean;
  deposits: number;
  frozen: number;
  roots: number;
  lastError: string | null;
  /**
   * When the scan position last moved, epoch seconds.
   *
   * Not a metric: it is the only thing that distinguishes a follower which is
   * catching up slowly from one that cannot advance at all. Both report a large
   * `behind`, and only the second is an incident. BSC testnet spent 44 hours in
   * the second state — retrying one 2000-block range whose logs had been pruned,
   * falling further behind every second — while `lastError` carried the message
   * and nothing raised an alarm.
   */
  atMovedAt: number;
  /**
   * The highest source-chain block whose evidence has reached the settlement
   * chain, or -1 where the question does not apply.
   *
   * It separates the two halves of a deposit's wait on a chain with a prover of
   * its own — before it, nothing exists to prove against; after it, only the
   * push is left. The follower computes this every tick anyway to decide what to
   * freeze; keeping it lets the API say which half a deposit is in.
   */
  provableUpTo: number;
  /** Contracts that do not point at the ones this instance was configured with. */
  wiring: string[];
  /** Polls lost to `HEAD_RACE` since start: a measure of the endpoint, not an incident. */
  headRaces: number;
};

/** A log in the queue: what a prover needs, and which crossing and block it is. */
type PendingLog = LogToFreeze & { ref: number; block: number };

export class EvmFollower {
  private cfg: IndexerConfig;
  private store: Store;
  private chain: EvmChain;
  private accounts: { lightClient: string; gateway: string };
  private exec: Exec;
  /** Scan position, per chain. One key for all of them crossed the streams. */
  private scannedKey: string;
  /**
   * One of these, never both: an EVM chain either has a beacon chain to ask about
   * finality, which this class proves against itself (`freezeLog`), or a prover
   * of its own — Parlia's votes, a Polygon milestone. The registry's `strategy`
   * decides, and everything else in this class
   * is the same either way — a receipts trie and a log are a receipts trie and a
   * log.
   */
  private beacon?: BeaconClient;
  private prover?: Prover;
  /**
   * Polygon's second way in: a checkpoint proof for a deposit the milestone
   * path has not closed in half an hour. See `fallbackToCheckpoints`.
   */
  private checkpointFallback?: CheckpointProver;
  private stopped = false;
  /**
   * Logs waiting for their block to finalize before a bundle can be built.
   *
   * Two kinds travel this way and the machinery does not care which: `Deposit`,
   * which the gateway turns into a credit, and `Voided`, which it turns into a
   * refund. Only the topic and the action it feeds differ.
   */
  private awaitingFinality = new Map<string, PendingLog>();
  /** A freeze that failed waits before the next try, instead of retrying every poll. */
  private readonly freezeRetry = new RetryLater();
  /** Settled checks that fail are filed only when they keep failing. */
  private readonly settledFailing = new FailureStreak(
    (detail) => this.store.incident('settled-check', `${this.chain.id}: ${detail}`),
    { lastingMs: SETTLED_LASTING_MS, gapMs: SETTLED_GAP_MS },
  );

  readonly state: EvmState = {
    at: 0, head: 0, caughtUp: false, deposits: 0, frozen: 0, roots: 0, lastError: null,
    atMovedAt: Math.floor(Date.now() / 1000), provableUpTo: -1, wiring: [], headRaces: 0,
  };

  constructor(cfg: IndexerConfig, store: Store, source: Source) {
    this.cfg = cfg;
    this.store = store;
    this.chain = source.chain;
    this.accounts = source.accounts;
    this.exec = execFor(source.exec);
    this.scannedKey = `evm.scanned.${this.chain.chainId}`;

    if (this.chain.strategy === 'parlia') {
      // Receipts from the archive when the deployment names one
      // (`ARCHIVE_URLS_<chainId>`), logs from the ordinary list. On BSC mainnet
      // no free endpoint does both: publicnode serves logs but answers a receipt
      // a few blocks old with 403 "archive requests require a personal token" —
      // and a 403 parks it for an hour, logs included — while Alchemy's free
      // tier serves every receipt but logs ten blocks at a time.
      this.prover = new ParliaProver(
        { evm: this.chain, accounts: this.accounts },
        this.chain.archive?.length ? execFor(this.chain.archive) : this.exec,
      );
    } else if (this.chain.strategy === 'milestone') {
      this.prover = new MilestoneProver(
        { evm: this.chain, accounts: this.accounts },
        this.chain.archive?.length ? execFor(this.chain.archive) : this.exec,
      );
      // The checkpoint walk, for what the milestone path does not close (audit
      // P-4): a format change at Heimdall, a relayer down past the trusting
      // period, a fast-forward gap. It proves on the Ethereum light client and
      // credits through the gateway's `creditcp`.
      const settlement = this.chain.settlesTo ? evmChain(this.chain.settlesTo) : undefined;
      // The checkpoint is proved on the light client of the chain it settles to,
      // as the API's fallback proof names it.
      const settlementClient = cfg.sources.find((s) => s.chain.id === settlement?.id)?.accounts.lightClient;
      if (this.chain.checkpoint && settlement && settlementClient && cfg.beaconUrls.length) {
        this.checkpointFallback = new CheckpointProver(
          {
            evm: this.chain,
            settlement,
            accounts: { lightClient: settlementClient, gateway: this.accounts.gateway },
            beaconUrls: cfg.beaconUrls,
          },
          this.exec,
        );
      } else {
        console.log(`[evm:${this.chain.id}] no checkpoint fallback: needs checkpoint parameters, a followed settlement chain and a beacon endpoint`);
      }
    } else {
      if (!cfg.beaconUrls.length) {
        throw new Error(`chain '${this.chain.id}' has no beacon endpoints; a deposit cannot be proved`);
      }
      this.beacon = new BeaconClient(cfg.beaconUrls[0]);
    }
  }

  /** Which chain this follower is for, so a supervisor can name it. */
  get id(): string {
    return this.chain.id;
  }

  /**
   * Where to start scanning with nothing saved, per chain.
   *
   * `EVM_FROM_BLOCK` is a block number, and a block number means nothing on a
   * chain other than the one it was written for: the instance's 11,670,000 is
   * early Sepolia and 120 million blocks of BSC history. So it applies to the
   * instance's own chain, and any other chain says so by name or starts at the
   * head — where "anything older" is picked up by reconciling against the bridge's
   * own tables anyway.
   */
  private get fromBlock(): number {
    const named = Number(process.env[`EVM_FROM_BLOCK_${this.chain.chainId}`] ?? 0);
    if (named) return named;
    return this.chain.id === this.cfg.evm.id ? this.cfg.evmFromBlock : 0;
  }

  /** The beacon client, or a named failure rather than a null dereference. */
  private requireBeacon(): BeaconClient {
    if (!this.beacon) {
      throw new Error(`'${this.chain.id}' has no beacon chain to ask about finality`);
    }
    return this.beacon;
  }

  stop(): void {
    this.stopped = true;
  }

  /**
   * Ask the contracts who they think they are working with.
   *
   * A redeployment that is not mirrored into the registry does not fail — it
   * goes quiet. The indexer follows an address that emits nothing, reports a
   * healthy stream, and never offers the cheap settlement track because it never
   * sees a root accepted. Two `eth_call`s at startup turn that into an alarm.
   *
   * It reports rather than corrects: which deployment is the live one is a
   * deployment decision, and guessing it here would be the same silent choice in
   * the other direction.
   */
  async verifyWiring(): Promise<string[]> {
    const problems: string[] = [];
    const { vault, withdrawals, lightClient } = this.chain;
    if (!vault || !withdrawals) return problems;

    const call = async (to: string, sig: string) =>
      addressFromWord(await this.exec.rpc('eth_call', [{ to, data: selector(sig) }, 'latest']));

    try {
      const releaser = await call(vault, 'releaser()');
      if (releaser !== withdrawals.toLowerCase()) {
        problems.push(
          `vault ${vault} names ${releaser} as its releaser, not the configured ` +
            `withdrawals contract ${withdrawals.toLowerCase()} — a release against the ` +
            `configured one would revert at the vault`,
        );
      }
      if (lightClient) {
        const theirs = await call(withdrawals, 'lightClient()');
        if (theirs !== lightClient.toLowerCase()) {
          problems.push(
            `withdrawals ${withdrawals.toLowerCase()} verifies against light client ${theirs}, ` +
              `but roots are being watched on ${lightClient.toLowerCase()} — the cheap ` +
              `settlement track will never be offered`,
          );
        }
      }
    } catch (err) {
      problems.push(`could not read the contracts' wiring: ${(err as Error).message}`);
    }

    for (const p of problems) {
      this.store.incident('wiring', p);
      console.log(`[evm:${this.chain.id}] WIRING: ${p}`);
    }
    return problems;
  }

  async start(): Promise<void> {
    this.state.wiring = await this.verifyWiring();
    const saved = this.store.getNumber(this.scannedKey);
    const configured = this.fromBlock;
    let from = saved ?? configured;

    // A configured start that is behind the saved position means a backfill was
    // asked for, and it has to actually happen: a saved position used to win
    // outright, which made `EVM_FROM_BLOCK` a setting that silently did nothing
    // on every run but the first. Everything earlier stayed invisible — a
    // withdrawal released days ago still looked outstanding.
    //
    // But it has to happen ONCE. Rewinding on every restart is what stalled BSC
    // testnet for 44 hours: `EVM_FROM_BLOCK_97` named the first Chapel deposit,
    // the follower had long since scanned past it, and each restart dragged it
    // back to a block whose logs the only working endpoint had since pruned.
    // From there it could not advance and lost ground every second — a backfill
    // hint that had quietly become a permanent rewind into an unreachable range.
    //
    // So the rewind is recorded. The same value does not rewind twice, and
    // changing it in the environment still asks for a new backfill.
    const rewoundKey = `evm.rewound.${this.chain.chainId}`;
    if (configured && saved !== undefined && configured < saved) {
      if (this.store.getNumber(rewoundKey) === configured) {
        console.log(
          `[evm:${this.chain.id}] configured start ${configured} was already backfilled; ` +
            `keeping the saved position ${saved}`,
        );
      } else {
        console.log(
          `[evm:${this.chain.id}] configured start ${configured} is behind the saved ` +
            `position ${saved}; rescanning from it once`,
        );
        this.store.setMeta(rewoundKey, String(configured));
        from = configured;
      }
    }

    if (!from) {
      // Nothing saved and nothing configured: start at the head rather than
      // walking Sepolia from genesis. Anything older is found by reconciliation
      // against the settlement chain's own tables.
      from = await this.exec.head();
      console.log(`[evm:${this.chain.id}] no saved position; starting at head ${from}`);
    }
    this.state.at = from;
    this.state.atMovedAt = Math.floor(Date.now() / 1000);
    this.recoverPending();

    // Polls that fail are filed only when they keep failing: the gateway's
    // upstreams come and go. A slow poll must not look like a pause between failures.
    const pollFailing = new FailureStreak((detail) => this.store.incident('evm-poll', detail), {
      gapMs: Math.max(GAP_MS, 3 * this.pollMs),
    });
    while (!this.stopped) {
      try {
        await this.tick();
        this.state.lastError = null;
      } catch (err) {
        const message = (err as Error).message;
        if (HEAD_RACE.test(message)) {
          // Not filed: it filled the incident log at one row every two minutes
          // and said nothing but that the endpoint is a load balancer.
          this.state.headRaces++;
        } else {
          this.state.lastError = message;
          pollFailing.failed(message);
          console.log(`[evm:${this.chain.id}] ${message}`);
        }
      }
      await sleep(this.pollMs, () => this.stopped);
    }
  }

  /**
   * How long between polls of this chain: `EVM_POLL_MS_<chainId>`, else the
   * instance's `EVM_POLL_MS`. Per chain because the cost is: a chain read
   * through a paid endpoint pays for every poll, one on a free one does not.
   */
  private get pollMs(): number {
    const own = Number(process.env[`EVM_POLL_MS_${this.chain.chainId}`] ?? 0);
    return own > 0 ? own : this.cfg.evmPollMs;
  }

  /**
   * Put deposits the database still calls unproved back in the queue.
   *
   * Without this the queue only ever held what the current process had scanned,
   * so restarting while a deposit waited for finality dropped it silently. It would sit at `seen` forever with the
   * API cheerfully reporting how long it had been waiting.
   */
  private recoverPending(): void {
    let n = 0;
    for (const row of this.store.pendingDeposits(this.chain.chainId)) {
      if (this.awaitingFinality.has(row.key)) continue;
      this.awaitingFinality.set(row.key, {
        key: row.key,
        kind: 'deposit',
        ref: row.ref,
        block: row.src_block,
        tx: String(row.src_tx),
        address: (this.chain.vault ?? '').toLowerCase(),
        topic0: TOPICS.deposit,
      });
      n++;
    }
    if (n) console.log(`[evm:${this.chain.id}] ${n} unproved deposit(s) recovered from the database`);
  }

  private async tick(): Promise<void> {
    // The head every endpoint has, not the head the first one claims. Logs are
    // read from more than one node, and asking a node that is a second behind
    // for a range it does not have yet is an error, not an empty answer — which
    // stops the scan advancing and leaves a settled crossing looking open.
    const head = await this.exec.head();
    this.state.head = head;

    while (this.state.at < head && !this.stopped) {
      const to = Math.min(this.state.at + LOG_SPAN, head);
      await this.scan(this.state.at + 1, to);
      this.state.at = to;
      this.state.atMovedAt = Math.floor(Date.now() / 1000);
      this.store.setMeta(this.scannedKey, String(to));
    }
    this.state.caughtUp = this.state.at >= head;
    await this.freezeMatured();
    await this.fallbackToCheckpoints();
  }

  /** When each stuck deposit's checkpoint proof was last tried, so a miss waits. */
  private fallbackTried = new Map<string, number>();

  /**
   * Polygon: give a deposit the milestone path has not closed in half an hour a
   * checkpoint proof instead, served as `proveroot` on the Ethereum light client
   * and `creditcp` on the gateway. Tried every five minutes until a checkpoint
   * covers the block and Ethereum finalizes past it — about forty minutes.
   */
  private async fallbackToCheckpoints(): Promise<void> {
    if (!this.checkpointFallback || !this.chain.vault) return;
    const now = Math.floor(Date.now() / 1000);
    for (const t of this.store.provedButOpen(this.chain.chainId, now - MILESTONE_FALLBACK_AFTER)) {
      if (this.stopped) return;
      const stored = this.store.getProof(t.key);
      if (!stored || JSON.parse(stored.body).strategy !== 'milestone') continue;
      if (now - (this.fallbackTried.get(t.key) ?? 0) < 300) continue;
      this.fallbackTried.set(t.key, now);
      try {
        const frozen = await this.checkpointFallback.freeze({
          key: t.key, kind: 'deposit', tx: t.src_tx!, address: this.chain.vault.toLowerCase(), topic0: TOPICS.deposit,
        });
        this.storeCommittee(frozen);
        this.store.dropProof(t.key);
        this.store.putProof(t.key, 'deposit', JSON.stringify({ ...JSON.parse(frozen.body), fallback: 'checkpoint' }));
        this.fallbackTried.delete(t.key);
        console.log(`[evm:${this.chain.id}] ${t.key}: milestone path did not close it; checkpoint proof frozen`);
      } catch (err) {
        console.log(`[evm:${this.chain.id}] ${t.key}: no checkpoint proof yet: ${(err as Error).message}`);
      }
    }
  }

  /**
   * When a block was mined, cached.
   *
   * `eth_getLogs` does not carry a timestamp, and taking the clock instead makes
   * every crossing discovered by a backfill scan look like it happened just now
   * — which is wrong in the history a user reads, and wrong in the deadline the
   * push queue computes from it.
   */
  private blockTimes = new Map<number, number>();

  private async blockTime(blockNumber: number): Promise<number> {
    const known = this.blockTimes.get(blockNumber);
    if (known !== undefined) return known;
    const block = await this.exec.rpc('eth_getBlockByNumber', ['0x' + blockNumber.toString(16), false]);
    const at = Number(block.timestamp);
    this.blockTimes.set(blockNumber, at);
    if (this.blockTimes.size > 4_096) {
      for (const k of [...this.blockTimes.keys()].slice(0, 2_048)) this.blockTimes.delete(k);
    }
    return at;
  }

  private async scan(from: number, to: number): Promise<void> {
    const addresses = [this.chain.vault, this.chain.withdrawals, this.chain.lightClient]
      .filter((a): a is string => Boolean(a))
      .map((a) => a.toLowerCase());
    if (!addresses.length) return;

    const logs = await this.exec.logs({
      fromBlock: '0x' + from.toString(16),
      toBlock: '0x' + to.toString(16),
      address: addresses,
    });

    for (const log of logs) {
      const address = String(log.address).toLowerCase();
      const topic0 = String(log.topics[0]).toLowerCase();
      const blockNumber = Number(log.blockNumber);

      const fromVault = address === this.chain.vault?.toLowerCase();

      if (fromVault && topic0 === TOPICS.deposit) {
        this.onDeposit(log, blockNumber, await this.blockTime(blockNumber));
      } else if (fromVault && topic0 === TOPICS.released) {
        // Anchored to the vault, because the withdrawals contract emits the same
        // signature for the same settlement and an unanchored match handled every
        // release twice. The vault is the right half of the pair to keep: custody
        // outlives the verifier in front of it, which is the same reason `Voided`
        // is proved from here and not from there.
        this.onSettled(log, blockNumber, 'released', await this.blockTime(blockNumber));
      } else if (topic0 === TOPICS.voided || topic0 === TOPICS.expired) {
        this.onSettled(log, blockNumber, 'expired', await this.blockTime(blockNumber));
      } else if (
        address === this.chain.lightClient?.toLowerCase() &&
        topic0 === TOPICS.rootAccepted
      ) {
        this.onRoot(log, blockNumber);
      }
    }
  }

  // --- events ---------------------------------------------------------------------

  /**
   * `Deposit(token, from, amount, canonical, telosTo, nonce, refundTo, fillFee,
   * filler, memo)`. The refund address and the fill terms are Telos's business
   * and are not stored here.
   *
   * `telosTo` is an Antelope name packed into a uint64 — the same encoding the
   * vault takes it in — so the account a UI shows comes straight out of the log.
   * A memo means the deposit is handed on by `forward` rather than claimed.
   */
  private onDeposit(log: any, blockNumber: number, at: number): void {
    const token = addressFromWord(log.topics[1]);
    const from = addressFromWord(log.topics[2]);
    const amount = BigInt(word(log.data, 0));
    const canonical = BigInt(word(log.data, 1));
    const telosTo = BigInt(word(log.data, 2));
    const nonce = Number(BigInt(word(log.data, 3)));
    const memo = bytesAt(log.data, 7);

    this.store.upsertTransfer({
      key: depositKey(this.chain.chainId, nonce),
      direction: 'deposit',
      ref: nonce,
      status: 'seen',
      account: uint64ToName(telosTo),
      evm_address: from,
      token,
      amount: canonical.toString(),
      amount_raw: amount.toString(),
      domain: String(this.chain.chainId),
      src_block: blockNumber,
      src_time: at,
      src_tx: String(log.transactionHash),
      memo: memo || null,
    });
    this.state.deposits++;

    const key = depositKey(this.chain.chainId, nonce);
    // Two reasons not to queue a finalized freeze, and both are permanent.
    //
    // Credited: the nonce is spent and a proof for it can never be used. Past
    // the ancestry window: the chain of headers no longer fits in a transaction
    // and never will again, so retrying is a failure logged every poll forever.
    // Neither closes the crossing — the fast path has no age limit and still
    // serves both on request.
    const known = this.store.getTransfer(key);
    const tooOld = Math.floor(Date.now() / 1000) - at > this.cfg.maxAncestry * 12;
    if (tooOld) {
      console.log(`[evm:${this.chain.id}] deposit #${nonce} is past the ancestry window; fast path only`);
    }
    if (!tooOld && !this.store.hasProof(key) && !(known && BOOKED.includes(known.status))) {
      this.awaitingFinality.set(key, {
        key,
        kind: 'deposit',
        ref: nonce,
        block: blockNumber,
        tx: String(log.transactionHash),
        address: String(log.address).toLowerCase(),
        topic0: TOPICS.deposit,
      });
    }
    console.log(`[evm:${this.chain.id}] deposit #${nonce} to ${uint64ToName(telosTo)} in block ${blockNumber}`);
  }

  /**
   * `Released(id, ...)` and `Voided(id)` / `Expired(id)` both key on the id.
   *
   * A `Voided` from the VAULT is more than a status: it is the log Telos has to
   * be shown before it will reissue the burned tokens, and `ethgateway11::voided`
   * checks that the log came from a whitelisted source — which is the vault, not
   * the withdrawals contract. So that one is queued for a proof; `Expired` from
   * the withdrawals contract is only news.
   */
  private onSettled(
    log: any,
    blockNumber: number,
    status: 'released' | 'expired',
    at: number,
  ): void {
    const id = Number(BigInt(log.topics[1]));
    const topic0 = String(log.topics[0]).toLowerCase();
    const address = String(log.address).toLowerCase();

    if (topic0 === TOPICS.voided && address === this.chain.vault?.toLowerCase()) {
      const key = voidKey(id);
      // A refunded withdrawal has already been reissued on the settlement chain;
      // proving the void again would prove something nobody can act on.
      const existing = this.store.getTransfer(withdrawalKey(id));
      if (!this.store.hasProof(key) && existing?.status !== 'refunded') {
        this.awaitingFinality.set(key, {
          key, kind: 'void', ref: id, block: blockNumber,
          tx: String(log.transactionHash), address, topic0,
        });
      }
    }

    this.store.upsertTransfer({
      key: withdrawalKey(id),
      direction: 'withdrawal',
      ref: id,
      status,
      // Burned on the settlement chain, which fills in where when it is read.
      firstSeen: { block: 0, time: at },
      dst_block: blockNumber,
      dst_time: at,
      dst_tx: String(log.transactionHash),
    });
    console.log(`[evm:${this.chain.id}] withdrawal ${id} ${status} in block ${blockNumber}`);
  }

  /**
   * A root the light client accepted.
   *
   * The block it was taken as of is not in the event — only the timestamp slot —
   * so it is filled in later by whoever can map one to the other. Until then the
   * root is recorded without it and simply does not offer the cheap track.
   */
  private onRoot(log: any, blockNumber: number): void {
    const mroot = String(log.topics[1]).toLowerCase();
    const slot = Number(BigInt(word(log.data, 1)));
    this.store.putRoot(mroot, slot, null, blockNumber, this.chain.chainId);
    this.state.roots = this.store.rootCount();
    console.log(`[evm:${this.chain.id}] root ${mroot.slice(0, 18)}… accepted at slot ${slot}`);
  }

  // --- deposit proofs ----------------------------------------------------------------

  /**
   * Freeze the deposits whose blocks have since finalized.
   *
   * Finalized rather than optimistic, deliberately. An optimistic bundle bakes
   * in a confirmation depth, so one frozen at twelve is worthless on a route
   * that later asks for twenty, while a finalized one can never become
   * insufficient. The cost is about thirteen minutes of waiting, which nobody is
   * waiting on: the fast path is served live, not from storage.
   */
  private async freezeMatured(): Promise<void> {
    if (!this.awaitingFinality.size) return;
    if (this.prover) return this.freezeMaturedWith(this.prover);

    const finality = await this.requireBeacon().finalityUpdate();
    const finalSlot = Number(finality.finalized_header.beacon.slot);

    for (const [key, p] of [...this.awaitingFinality]) {
      if (this.store.hasProof(key)) {
        this.awaitingFinality.delete(key);
        continue;
      }
      if (!this.freezeRetry.due(key)) continue;
      try {
        const slot = slotForTimestamp(await this.blockTime(p.block));
        if (finalSlot < slot) continue; // still inside the ~13-minute window

        await this.recordFrozen(p, await this.freezeLog(p, slot, finalSlot, finality));
        this.awaitingFinality.delete(key);
        this.freezeRetry.succeeded(key);
      } catch (err) {
        this.store.incident('log-freeze', `${key}: ${(err as Error).message}`);
        const wait = this.freezeRetry.failed(key);
        console.log(`[evm:${this.chain.id}] freeze failed for ${key}, next try in ${Math.round(wait / 1000)} s: ${(err as Error).message}`);
        // A chain too long to prove will not get shorter. Stop retrying it every
        // poll and leave it as an incident somebody can act on.
        if ((err as Error).message.includes('too far behind')) this.awaitingFinality.delete(key);
      }
    }
  }

  /**
   * Freeze what a chain's own prover says is mature.
   *
   * The beacon path asks a node what is final and then measures how far the log
   * sits behind it, because the answer decides how much ancestry the proof has to
   * carry. A prover answers the first question itself — a Parlia vote finalizes
   * one block outright, a Polygon milestone covers a range — and carries no
   * ancestry, so a log that arrives late costs nothing extra and there is no
   * `too far behind` case to give up on.
   *
   * What it says is mature is kept as `provableUpTo`: the API tells a waiting
   * deposit which half of its wait it is in by it.
   */
  private async freezeMaturedWith(prover: Prover): Promise<void> {
    const mature = await prover.matureBelow(this.state.head);
    this.state.provableUpTo = mature;
    if (mature < 0) return;

    for (const [key, p] of [...this.awaitingFinality]) {
      if (this.store.hasProof(key)) {
        this.awaitingFinality.delete(key);
        continue;
      }
      if (p.block > mature) continue;
      if (!this.freezeRetry.due(key)) continue;
      try {
        await this.recordFrozen(p, await prover.freeze(p));
        this.awaitingFinality.delete(key);
        this.freezeRetry.succeeded(key);
      } catch (err) {
        this.store.incident('log-freeze', `${key}: ${(err as Error).message}`);
        const wait = this.freezeRetry.failed(key);
        console.log(`[evm:${this.chain.id}] freeze failed for ${key}, next try in ${Math.round(wait / 1000)} s: ${(err as Error).message}`);
      }
    }
  }

  /** Store a frozen proof, and move its deposit to `provable`. */
  private async recordFrozen(p: PendingLog, frozen: Frozen): Promise<void> {
    this.storeCommittee(frozen);
    this.store.putProof(p.key, p.kind, frozen.body);
    this.state.frozen++;

    if (p.kind === 'deposit') {
      this.store.upsertTransfer({
        key: p.key,
        direction: 'deposit',
        ref: p.ref,
        status: 'provable',
        firstSeen: { block: p.block, time: await this.blockTime(p.block) },
        proof_at: Math.floor(Date.now() / 1000),
      });
    }
    console.log(
      `[evm:${this.chain.id}] froze ${p.kind} ${p.key} (${(frozen.body.length / 1024).toFixed(1)} KB, ` +
        `signed by ${frozen.signedBy})`,
    );
  }

  /**
   * The committee a beacon-anchored proof was signed by, stored once for its
   * period. The period comes off the committee the bundle actually used, not
   * off a header's slot: those agree today and would stop agreeing at a period
   * boundary.
   */
  private storeCommittee(frozen: Frozen): void {
    if (frozen.committee) {
      this.store.putCommittee(frozen.committee.period, frozen.committee.keys, frozen.committee.aggKey);
    }
  }

  /**
   * Freeze one log as a finalized bundle.
   *
   * Finalized rather than optimistic, deliberately. An optimistic bundle bakes
   * in a confirmation depth, so one frozen at twelve is worthless on a route
   * that later asks for twenty, while a finalized one can never become
   * insufficient. The cost is about thirteen minutes of waiting, which nobody is
   * waiting on: the fast path is served live, not from storage.
   */
  private async freezeLog(
    p: PendingLog,
    slot: number,
    finalSlot: number,
    finality: any,
  ): Promise<Frozen> {
    const span = finalSlot - slot + 1;
    if (span > this.cfg.maxAncestry) {
      throw new Error(
        `block ${p.block} is ${span} slots behind finality — too far behind to prove in one ` +
          `transaction (${span} headers of ancestry at 112 bytes, against a 600 KB limit that ` +
          `already holds a ~49 KB committee). It needed freezing within ~16 hours of the block.`,
      );
    }

    // The chain of headers from the log's block up to the finalized one. Empty
    // slots are common, so ask for a generous window and keep what lands at or
    // below the tip.
    const { headers } = await ancestryOfLength(this.requireBeacon(), slot, span, span + 64);
    const ancestry = headers.filter((h: any) => h.slot <= finalSlot);
    if (!ancestry.length || ancestry[0].slot !== slot) {
      throw new Error(`the beacon chain does not start at slot ${slot}`);
    }

    const bundle = await buildProofBundle({
      beaconUrl: this.cfg.beaconUrls[0],
      update: finality,
      carrierUpdate: await updateFromBlocks(this.requireBeacon(), slot),
      // Drop the tip: the contract links the finalized header to the top of the
      // chain by `parent_root`, so it must not also be inside it.
      ancestry: ancestry.filter((h: any) => h.slot !== finalSlot),
      target: p.tx,
      wantLog: { address: p.address, topic0: p.topic0 },
    });

    const proveroot = proverootArgs(bundle, this.accounts.lightClient);
    const gatewayArgs = creditArgs(bundle, this.accounts.gateway);

    // The committee is ~49 KB and identical for every proof in its period, so it
    // is stored once and stitched back in when one is served.
    const { keys, agg_key, ...slim } = proveroot;
    const signedBy = `${bundle.bls.signedCount}/${bundle.bls.committeeSize}`;
    const body = JSON.stringify({
      kind: p.kind,
      committeePeriod: bundle.committee.period,
      blockNumber: bundle.event.blockNumber,
      blockHash: bundle.event.blockHashHex,
      signedBy,
      ancestry: bundle.event.ancestry.length,
      proveroot: slim,
      gateway: gatewayArgs,
    });
    return {
      body,
      blockNumber: bundle.event.blockNumber,
      signedBy,
      committee: { period: bundle.committee.period, keys, aggKey: agg_key },
    };
  }

  /**
   * Ask the vault whether a withdrawal it still lists as outstanding is settled.
   *
   * `wdraws` on the settlement chain cannot know: a release happens on this side
   * and nothing carries the news back until `settle` exists. So a withdrawal can
   * be paid out here and still read as open there — and a queue built only from
   * the settlement chain's view then offers a transaction that reverts with
   * `AlreadySettled`, after the user has paid for the gas.
   *
   * One `eth_call` per outstanding withdrawal answers it. The flag does not say
   * which way it went, so the event is looked up once to distinguish a payout
   * from a rollback.
   */
  async checkSettled(): Promise<number> {
    const vault = this.chain.vault;
    if (!vault) return 0;
    const outstanding = this.store.openWithdrawals(this.chain.chainId);
    if (!outstanding.length) return 0;

    let fixed = 0;
    for (const t of outstanding) {
      try {
        const word = await this.exec.rpc('eth_call', [
          { to: vault, data: selector('released(uint64)') + t.ref.toString(16).padStart(64, '0') },
          'latest',
        ]);
        if (BigInt(word) !== 1n) continue;

        const found = await this.findSettlement(t.ref);
        // The search walks history and can take minutes; the poller may have
        // recorded the settlement meanwhile. Statuses only move forward, so a
        // changed one is that (w:460 on BSC, 2026-10-25: paid while this pass
        // ran, its search started from a node a block behind and found nothing).
        const recordedMeanwhile = this.store.getTransfer(t.key)?.status !== t.status;
        this.store.upsertTransfer({
          key: t.key,
          direction: 'withdrawal',
          ref: t.ref,
          status: found?.status ?? 'released',
          dst_block: found?.block ?? null,
          dst_time: found?.at ?? null,
          dst_tx: found?.tx ?? null,
        });
        // A settlement in a block the log poller has not reached yet is a race
        // this pass merely won (w:364 on BSC, 2026-10-22: paid twelve seconds
        // before the next poll). Only one behind the poller was missed.
        if (!recordedMeanwhile && (!found || found.block <= this.state.at)) {
          this.store.incident(
            'settled-elsewhere',
            `withdrawal ${t.ref} is settled on the vault (${found?.status ?? 'released'}` +
              `${found ? ` in block ${found.block}` : ', event not found in the scanned range'}), ` +
              `but was still listed as ${t.status}`,
          );
        }
        console.log(`[evm:${this.chain.id}] withdrawal ${t.ref} was already ${found?.status ?? 'settled'} on chain`);
        fixed++;
      } catch (err) {
        this.settledFailing.failed(`withdrawal ${t.ref}: ${(err as Error).message}`);
        console.log(`[evm:${this.chain.id}] settled check, withdrawal ${t.ref}: ${(err as Error).message}`);
      }
    }
    return fixed;
  }

  /** Which way a settled id went, and where. Indexed by id, so the node barely works. */
  private async findSettlement(
    id: number,
  ): Promise<{ status: 'released' | 'expired'; block: number; at: number; tx: string } | undefined> {
    const vault = this.chain.vault!;
    const idTopic = '0x' + id.toString(16).padStart(64, '0');
    // Never below where the poller already is: a node a block behind would
    // start the search under a settlement that has just happened.
    const head = Math.max(await this.exec.head(), this.state.head);
    const floor = this.fromBlock || head - 500_000;

    // In LOG_SPAN steps, not wide ones. A public node handed a fifty-thousand
    // block range does not refuse it — it answers with nothing, which reads as
    // "no such event" and is how withdrawal 1 came back as settled with no
    // record of which way it went. Both ends are inclusive, so a step is
    // `to - LOG_SPAN + 1 … to`: one block more and Ankr refuses the range.
    for (let to = head; to >= floor; to -= LOG_SPAN) {
      const from = Math.max(floor, to - LOG_SPAN + 1);
      for (const [topic, status] of [
        [TOPICS.released, 'released'],
        [TOPICS.voided, 'expired'],
      ] as const) {
        // Searching history, where an empty answer can be a pruned index
        // rather than an absence, so it has to be confirmed by every endpoint.
        const logs = await this.exec.logs(
          {
            fromBlock: '0x' + from.toString(16),
            toBlock: '0x' + to.toString(16),
            address: vault,
            topics: [topic, idTopic],
          },
          { confirmEmpty: true },
        );
        if (!logs.length) continue;
        const log = logs[logs.length - 1];
        const block = Number(log.blockNumber);
        return { status, block, at: await this.blockTime(block), tx: String(log.transactionHash) };
      }
    }
    return undefined;
  }
}

function sleep(ms: number, stopped: () => boolean): Promise<void> {
  return new Promise((r) => {
    const t = setTimeout(r, ms);
    t.unref?.();
    if (stopped()) {
      clearTimeout(t);
      r();
    }
  });
}
