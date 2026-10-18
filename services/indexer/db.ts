/**
 * Storage for everything that is not the tree.
 *
 * `node:sqlite` is built into Node, so the image needs no native module and no
 * build stage. The tree itself lives in files — a frontier, checkpoints and the
 * leaf window — because it is append-only and is read by offset, not by query.
 *
 * Five things live here:
 *
 *   transfers   one row per crossing, both directions, with the status a UI shows
 *   proofs      the frozen artifact for a transfer; the perishable thing
 *   policies    finalizer policies with their full key lists, as they are published
 *   roots       roots already trusted on the EVM side, which decide the cheap track
 *   handovers   the certificate that carries each policy rotation to an EVM light client
 *   hops        which withdrawal carries a deposit on through `bridgehop`, and where it goes back
 *   swaps       the orders `bridgeroute` made of payouts, and how each ended
 *
 * Only `proofs` and `handovers` are irreplaceable. Everything else can be rebuilt by rescanning
 * the two chains, and the indexer does exactly that on every restart.
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type Direction = 'deposit' | 'withdrawal';

/**
 * Where a transfer has got to.
 *
 *   deposit     seen -> provable -> credited
 *                               \-> parked -> forwarded | bounced
 *   withdrawal  burned -> provable -> released | expired -> refunded
 *
 * `parked` is a deposit the bridge booked but has not handed on yet: it carries
 * a memo, or names an account that did not exist. `forwarded` is the transfer
 * that delivered it, `bounced` the withdrawal that sends it back — which is a
 * crossing of its own, `w:<id>`, owned by the bridge.
 *
 * `provable` is the indexer's own word, not the chain's: it means a complete
 * proof is stored and the crossing can be finished by anyone at any time. It is
 * the state that makes the deadline stop mattering.
 */
export type TransferStatus =
  | 'seen'
  | 'provable'
  | 'credited'
  | 'parked'
  | 'forwarded'
  | 'bounced'
  | 'burned'
  | 'released'
  | 'expired'
  | 'refunded';

export type TransferRow = {
  key: string;
  direction: Direction;
  ref: number;
  status: TransferStatus;
  account: string | null;
  evm_address: string | null;
  token: string | null;
  symbol: string | null;
  amount: string | null;
  amount_raw: string | null;
  /**
   * The route's domain, as the ledger keys it: an EVM chain id, or for an
   * Antelope chain the first eight bytes of its chain id — a uint64, kept as a
   * string because WAX's (1181148696416462999) is past what a number holds.
   */
  domain: string | null;
  src_block: number;
  src_time: number;
  src_tx: string | null;
  dst_block: number | null;
  dst_time: number | null;
  dst_tx: string | null;
  deadline: number | null;
  proof_at: number | null;
  /**
   * The third transaction, which only a rollback has.
   *
   * A crossing normally takes two: one where it starts and one where it lands.
   * A withdrawal that is rolled back takes three — burned here, expired there,
   * reissued here — and the last one has nowhere else to go.
   */
  refund_tx: string | null;
  /** What a deposit asked to be handed on with; null for a plain one. */
  memo: string | null;
  updated_at: number;
};

/**
 * What one write says about a transfer: the key and the status it reached, and
 * whatever else it knows. `firstSeen` places a row this write creates; see
 * `Store.upsertTransfer`.
 */
export type TransferWrite = Partial<Omit<TransferRow, 'updated_at'>> &
  Pick<TransferRow, 'key' | 'direction' | 'ref' | 'status'> & {
    firstSeen?: { block: number; time: number };
  };

/**
 * One withdrawal `bridgehop` opened: a deposit carried on to another chain, or
 * a voided hop sent back. Read from the contract's `bind`, which names both.
 */
export type HopRow = {
  /** The ledger's withdrawal id, so the transfer row `w:<id>` is this leg. */
  id: number;
  /** The hop this one sends back; null when a deposit arrived. */
  prev: number | null;
  /** The deposit this hop carries on, `d:<domain>:<nonce>`; null for a way back. */
  deposit: string | null;
  quantity: string;
  to_domain: string;
  to_recipient: string;
  back_domain: string;
  back_recipient: string;
  tx: string;
  block: number;
  at: number;
};

/**
 * One order of `bridgeroute` on a chain a crossing reached: the payout it was
 * made of, and — once it ended — how, and what was delivered where. Assets are
 * written `<quantity>@<contract>`, as the contract's memos write them; a place
 * is an account on that chain, or `<domain>:<recipient>` on another.
 */
/** Tokens a bridgeroute order delivered, and where: an account on its chain, or `<domain>:<recipient>`. */
export type SwapPayment = { to: string; asset: string };

export type SwapRow = {
  /** The chain's registry id: `wax`, `telos`. */
  chain: string;
  id: number;
  /** The transaction that paid the crossing out to bridgeroute: a transfer row's `dst_tx`. */
  payout_tx: string;
  /** Where the token bought goes. For a payout delivered at once, where it went. */
  recipient: string;
  /** Where the token that arrived goes if it is never swapped. */
  back: string;
  /** What arrived. */
  input: string;
  /** The token to buy and the least of it; null for a payout paid on at once. */
  least: string | null;
  deadline: number | null;
  /** `swapped`, `unread`, `late`, `expired`, `cancelled`; null while open. */
  outcome: string | null;
  /** JSON list of `{ to, asset }` delivered; null while open. */
  paid: string | null;
  closed_tx: string | null;
  opened_at: number;
  closed_at: number | null;
};

/** One group of `Store.volume`: `amount` is a sum in canonical units, as text. */
export type VolumeRow = {
  direction: Direction;
  domain: string | null;
  token: string | null;
  day: string | null;
  count: number;
  amount: string | null;
  accounts: number;
  addresses: number;
};

export type ProofRow = {
  key: string;
  kind: string;
  body: string;
  bytes: number;
  created_at: number;
};

/**
 * Proof keys. The direction is part of the key, so ids from the two may collide.
 *
 *   w:<id>      the withdrawal artifact — submitRoot + release, pushed on the EVM
 *   v:<id>      proof of the vault's `Voided` log — pushed on Antelope to refund
 *   d:<nonce>   a deposit bundle — proveroot + credit, pushed on Antelope
 *
 * A withdrawal that is rolled back needs both `w:` and `v:`, at different times
 * and on different chains, which is why the void proof is not folded into the
 * artifact.
 */
export const withdrawalKey = (id: number | string) => `w:${id}`;

export const voidKey = (id: number | string) => `v:${id}`;
/**
 * A deposit is keyed by its chain AND its nonce.
 *
 * The nonce is the vault's own counter, one per vault, so `d:1` named a Sepolia
 * deposit and a BSC deposit at the same time the moment a second chain appeared.
 * Two rows with one key in a table keyed by it is not a conflict anybody notices:
 * the second write replaces the first, and a deposit that was credited starts
 * reading as somebody else's.
 *
 * Withdrawals and voids keep their bare ids: those come from the bridge, which is
 * shared, and are already unique across every route.
 */
export const depositKey = (domain: number | string, nonce: number | string) =>
  `d:${domain}:${nonce}`;

/**
 * A domain as the `roots` table keys it and the EVM followers name it: a chain
 * id, a small integer. An Antelope route's domain is the first eight bytes of
 * its chain id — WAX's is 1181148696416462999, past 2^53 — and has no EVM light
 * client to hold a root, so it is `undefined` here.
 */
export function evmDomain(raw: unknown): number | undefined {
  const n = Number(String(raw));
  return Number.isSafeInteger(n) ? n : undefined;
}

/**
 * A token as a row carries it: an EVM address with its `0x`, an Antelope token's
 * packed (contract, symbol) bare, both lowercase.
 *
 * The ledger writes both bare, the EVM follower reads an address with the
 * prefix, and one deposit is written by both. Two spellings of one token made
 * one asset read as two wherever rows are grouped by it.
 */
export function externalToken(domain: number | string, ext: string): string {
  const hex = ext.toLowerCase().replace(/^0x/, '');
  return evmDomain(domain) === undefined ? hex : `0x${hex}`;
}

export class Store {
  readonly db: DatabaseSync;

  constructor(file: string) {
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    // WAL so the follower's writes never block an API read.
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.createSchema();
  }

  /**
   * The schema, whole. The one-off migrations that brought databases from the
   * field up to it ran on every live one and were removed on 2026-10-12; a
   * database older than that must be rebuilt, not opened.
   */
  /**
   * One-off, 2026-10-13: bridgeroute's orders gained `back` and deliveries to
   * other chains, and its `opened`/`closed` changed shape. A swaps table from
   * before is dropped, and each chain's swaps cursor moved to now so the old
   * actions are not read again. Remove once every live database has run it.
   */
  private dropSwapsBeforeLegs(): void {
    const columns = this.db.prepare(`PRAGMA table_info(swaps)`).all() as { name: string }[];
    if (!columns.length || columns.some((c) => c.name === 'back')) return;
    this.db.exec('DROP TABLE swaps');
    this.db
      .prepare(`UPDATE meta SET value = ? WHERE key LIKE 'swaps:%'`)
      .run(String(Math.floor(Date.now() / 1000)));
  }

  private createSchema(): void {
    this.dropSwapsBeforeLegs();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

      CREATE TABLE IF NOT EXISTS transfers (
        key         TEXT PRIMARY KEY,
        direction   TEXT    NOT NULL,
        ref         INTEGER NOT NULL,
        status      TEXT    NOT NULL,
        account     TEXT,
        evm_address TEXT,
        token       TEXT,
        symbol      TEXT,
        amount      TEXT,
        amount_raw  TEXT,
        domain      TEXT,
        src_block   INTEGER NOT NULL,
        src_time    INTEGER NOT NULL,
        src_tx      TEXT,
        dst_block   INTEGER,
        dst_time    INTEGER,
        dst_tx      TEXT,
        deadline    INTEGER,
        proof_at    INTEGER,
        refund_tx   TEXT,
        memo        TEXT,
        updated_at  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS transfers_account ON transfers (account, src_time DESC);
      CREATE INDEX IF NOT EXISTS transfers_evm     ON transfers (evm_address, src_time DESC);
      CREATE INDEX IF NOT EXISTS transfers_status  ON transfers (status, src_time DESC);
      CREATE INDEX IF NOT EXISTS transfers_time    ON transfers (src_time DESC);

      -- Deliberately outside every sweep. A proof is two kilobytes, withdrawals
      -- are rare, and losing one means burned tokens with no way to finish the
      -- crossing in either direction.
      CREATE TABLE IF NOT EXISTS proofs (
        key        TEXT PRIMARY KEY,
        kind       TEXT    NOT NULL,
        body       TEXT    NOT NULL,
        bytes      INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );

      -- Full key lists, as the chain publishes them. Kept because the alternative
      -- is a binary search over state-history at the moment an artifact is being
      -- frozen, against retention that may already have moved past it.
      CREATE TABLE IF NOT EXISTS policies (
        generation INTEGER PRIMARY KEY,
        block      INTEGER NOT NULL,
        body       TEXT    NOT NULL
      );

      -- The certificate that hands each generation over to the next, with the
      -- successor's packed policy: what an EVM light client needs to follow
      -- Telos's rotation. Built from state-history, which keeps it about a day,
      -- and a client that has to follow later has nowhere else to get it. Never
      -- pruned, for the same reason as proofs.
      CREATE TABLE IF NOT EXISTS handovers (
        generation INTEGER PRIMARY KEY,
        block      INTEGER NOT NULL,
        body       TEXT    NOT NULL
      );

      -- Roots an EVM light client has accepted, PER CHAIN. Never pruned: the
      -- mapping on chain is never cleared either, and this is what tells a
      -- settlement it can take the 135k-gas path instead of paying for a root.
      --
      -- The domain column is not decoration. A root is trusted on the chain it
      -- was submitted to and nowhere else, and this table used to key on mroot
      -- alone -- so with four followers writing into it, a root submitted on
      -- Sepolia made the API answer "light track, no submitRoot needed" for
      -- Amoy, where it had never been submitted. Following that answer reverts
      -- with UntrustedRoot and costs the caller the gas.
      --
      -- The key is therefore the pair. Rows written before this column existed
      -- carry NULL and match no chain, sending those withdrawals down the hard
      -- track: more expensive, always correct.
      CREATE TABLE IF NOT EXISTS roots (
        mroot      TEXT NOT NULL,
        domain     INTEGER,
        slot       INTEGER NOT NULL,
        block      INTEGER,
        evm_block  INTEGER NOT NULL,
        seen_at    INTEGER NOT NULL,
        PRIMARY KEY (mroot, domain)
      );
      CREATE INDEX IF NOT EXISTS roots_block ON roots (block DESC);

      -- Sync committees, one row per period, ~49 KB each.
      --
      -- Carved out of the deposit proofs rather than repeated inside them: the
      -- 512 keys are the largest thing in a proveroot transaction and they are
      -- identical for every deposit in the same 27-hour period. Stored once,
      -- stitched back in when a proof is asked for.
      CREATE TABLE IF NOT EXISTS committees (
        period     INTEGER PRIMARY KEY,
        keys       TEXT    NOT NULL,
        agg_key    TEXT    NOT NULL,
        bytes      INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );

      -- Claims, as they happen. A credit issues to the bridge and records what
      -- the beneficiary may collect; the collecting is a separate act, and a UI
      -- that says "credited" without saying whether it was picked up is telling
      -- half of it.
      CREATE TABLE IF NOT EXISTS claims (
        trx_id TEXT PRIMARY KEY,
        owner  TEXT    NOT NULL,
        symbol TEXT    NOT NULL,
        block  INTEGER NOT NULL,
        at     INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS claims_owner ON claims (owner, at DESC);

      -- Hops through bridgehop. The stream is the only place a hop's deposit is
      -- named — the contract keeps the withdrawal and the way back, and forgets
      -- both once recovered — so, like proofs, these are not rebuilt from
      -- tables.
      CREATE TABLE IF NOT EXISTS hops (
        id             INTEGER PRIMARY KEY,
        prev           INTEGER,
        deposit        TEXT,
        quantity       TEXT    NOT NULL,
        to_domain      TEXT    NOT NULL,
        to_recipient   TEXT    NOT NULL,
        back_domain    TEXT    NOT NULL,
        back_recipient TEXT    NOT NULL,
        tx             TEXT    NOT NULL,
        block          INTEGER NOT NULL,
        at             INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS hops_deposit ON hops (deposit);
      CREATE INDEX IF NOT EXISTS hops_prev    ON hops (prev);
      CREATE INDEX IF NOT EXISTS hops_to      ON hops (to_recipient);
      CREATE INDEX IF NOT EXISTS hops_back    ON hops (back_recipient);

      -- Orders of bridgeroute, read from its opened and closed actions in Hyperion.
      -- The contract erases a row when the order ends, so this is the only place
      -- that says how a swap at the far end of a crossing came out.
      CREATE TABLE IF NOT EXISTS swaps (
        chain      TEXT    NOT NULL,
        id         INTEGER NOT NULL,
        payout_tx  TEXT    NOT NULL,
        recipient  TEXT    NOT NULL,
        back       TEXT    NOT NULL,
        input      TEXT    NOT NULL,
        least      TEXT,
        deadline   INTEGER,
        outcome    TEXT,
        paid       TEXT,
        closed_tx  TEXT,
        opened_at  INTEGER NOT NULL,
        closed_at  INTEGER,
        PRIMARY KEY (chain, id)
      );
      CREATE INDEX IF NOT EXISTS swaps_payout ON swaps (payout_tx);

      -- Anything an operator would want to find afterwards: a stream gap, a
      -- freeze that failed, a reconnect. Small and capped.
      CREATE TABLE IF NOT EXISTS incidents (
        id     INTEGER PRIMARY KEY AUTOINCREMENT,
        at     INTEGER NOT NULL,
        kind   TEXT    NOT NULL,
        detail TEXT    NOT NULL
      );
    `);
  }

  // --- meta ---------------------------------------------------------------------

  getMeta(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  getNumber(key: string): number | undefined {
    const v = this.getMeta(key);
    return v === undefined ? undefined : Number(v);
  }

  // --- transfers ----------------------------------------------------------------

  /**
   * Insert or update, without ever moving a transfer backwards.
   *
   * Both chains are scanned again after every restart, so the same event is seen
   * many times. A plain upsert would then walk a released withdrawal back to
   * `burned` the first time the Antelope side is re-read.
   *
   * Where a crossing started is known by whoever saw it start, and most writes
   * are a later step that does not know it. Those pass `firstSeen` — the place a
   * row this write creates starts at — and a row that already exists keeps its
   * own. A write that creates a row and says neither is refused: the row would
   * have no place in any history.
   */
  upsertTransfer(row: TransferWrite): void {
    const now = Math.floor(Date.now() / 1000);
    const { firstSeen, ...fields } = row;
    const existing = this.getTransfer(row.key);
    const start = existing ?? {
      src_block: fields.src_block ?? firstSeen?.block,
      src_time: fields.src_time ?? firstSeen?.time,
    };
    if (start.src_block === undefined || start.src_time === undefined) {
      throw new Error(`${row.key} is a new transfer and the write says neither src_block/src_time nor firstSeen`);
    }
    const merged: TransferRow = {
      account: null, evm_address: null, token: null, symbol: null, amount: null,
      amount_raw: null, domain: null, src_tx: null, dst_block: null, dst_time: null,
      dst_tx: null, deadline: null, proof_at: null, refund_tx: null, memo: null,
      ...start,
      ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined && v !== null)),
      key: row.key,
      direction: row.direction,
      ref: row.ref,
      status: existing ? later(existing.status, row.status) : row.status,
      updated_at: now,
    } as TransferRow;

    this.db
      .prepare(
        `INSERT INTO transfers (key, direction, ref, status, account, evm_address, token, symbol,
            amount, amount_raw, domain, src_block, src_time, src_tx, dst_block, dst_time, dst_tx,
            deadline, proof_at, refund_tx, memo, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(key) DO UPDATE SET
           status = excluded.status, account = excluded.account,
           evm_address = excluded.evm_address, token = excluded.token, symbol = excluded.symbol,
           amount = excluded.amount, amount_raw = excluded.amount_raw, domain = excluded.domain,
           src_block = excluded.src_block, src_time = excluded.src_time, src_tx = excluded.src_tx,
           dst_block = excluded.dst_block, dst_time = excluded.dst_time, dst_tx = excluded.dst_tx,
           deadline = excluded.deadline, proof_at = excluded.proof_at,
           refund_tx = excluded.refund_tx, memo = excluded.memo,
           updated_at = excluded.updated_at`,
      )
      .run(
        merged.key, merged.direction, merged.ref, merged.status, merged.account,
        merged.evm_address, merged.token, merged.symbol, merged.amount, merged.amount_raw,
        merged.domain, merged.src_block, merged.src_time, merged.src_tx, merged.dst_block,
        merged.dst_time, merged.dst_tx, merged.deadline, merged.proof_at, merged.refund_tx,
        merged.memo, merged.updated_at,
      );
  }

  getTransfer(key: string): TransferRow | undefined {
    return this.db.prepare('SELECT * FROM transfers WHERE key = ?').get(key) as
      | TransferRow
      | undefined;
  }

  listTransfers(q: {
    account?: string;
    address?: string;
    direction?: Direction;
    status?: string;
    before?: number;
    limit?: number;
  }): TransferRow[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (q.account) { where.push('account = ?'); args.push(q.account); }
    if (q.address) { where.push('evm_address = ?'); args.push(q.address.toLowerCase()); }
    if (q.direction) { where.push('direction = ?'); args.push(q.direction); }
    if (q.status) { where.push('status = ?'); args.push(q.status); }
    if (q.before) { where.push('src_time < ?'); args.push(q.before); }
    const sql =
      'SELECT * FROM transfers' +
      (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
      ' ORDER BY src_time DESC, ref DESC LIMIT ?';
    args.push(Math.min(q.limit ?? 50, 500));
    return this.db.prepare(sql).all(...(args as any[])) as TransferRow[];
  }

  /** Every row, newest first: what `/v1/activity` folds into transfers. */
  allTransfers(): TransferRow[] {
    return this.db.prepare('SELECT * FROM transfers ORDER BY src_time DESC, ref DESC').all() as TransferRow[];
  }

  /**
   * Deposits seen on a source chain and not yet proved.
   *
   * The follower keeps its queue of these in memory, filled as it scans. That
   * made a restart lose them: everything below the saved scan position is never
   * scanned again, so a deposit waiting on a slow proposer was simply forgotten
   * and nothing would ever prove it. It only appeared to work because a
   * configured start block rewound the scan on every restart — which was itself
   * the bug that stalled BSC testnet for 44 hours.
   *
   * So the queue is rebuilt from here instead. A row carries everything the
   * proof needs: the transaction, the block, and the nonce.
   */
  pendingDeposits(domain: string | number): TransferRow[] {
    return this.db
      .prepare(
        `SELECT t.* FROM transfers t LEFT JOIN proofs p ON p.key = t.key
         WHERE t.direction = 'deposit' AND t.domain = ?
           AND t.status NOT IN (${BOOKED.map((s) => `'${s}'`).join(', ')})
           AND t.src_tx IS NOT NULL AND t.src_block > 0 AND p.key IS NULL
         ORDER BY t.src_block`,
      )
      // As text, whatever the caller holds. `domain` is a TEXT column and
      // node:sqlite binds a JS number as a REAL, which compares as '1.0' and
      // matches nothing — so an EVM follower asking with its chain id got an
      // empty queue, and a deposit seen before a restart was never proved.
      .all(String(domain)) as TransferRow[];
  }

  /**
   * Deposits with a proof stored but not yet credited, seen before `before`.
   * Polygon's fallback reads these: a milestone receipt nobody managed to push in
   * half an hour gets a checkpoint proof instead (audit P-4).
   */
  provedButOpen(domain: string | number, before: number): TransferRow[] {
    return this.db
      .prepare(
        `SELECT t.* FROM transfers t JOIN proofs p ON p.key = t.key
         WHERE t.direction = 'deposit' AND t.domain = ?
           AND t.status NOT IN (${BOOKED.map((s) => `'${s}'`).join(', ')})
           AND t.src_tx IS NOT NULL AND t.src_time < ?
         ORDER BY t.src_block`,
      )
      .all(String(domain), before) as TransferRow[];
  }

  /** Open withdrawals with no artifact — the one count that has a clock on it. */
  unfrozenWithdrawals(): TransferRow[] {
    // EVM-bound only. One bound for an Antelope chain is proved by that chain's
    // relayer from the stream and never has an artifact here to be missing.
    return (this.db
      .prepare(
        `SELECT t.* FROM transfers t LEFT JOIN proofs p ON p.key = t.key
         WHERE t.direction = 'withdrawal' AND t.status IN ('burned','provable')
           AND p.key IS NULL ORDER BY t.src_time`,
      )
      .all() as TransferRow[]).filter((t) => t.domain === null || evmDomain(t.domain) !== undefined);
  }

  /**
   * Withdrawals bound for `domain` that are still open — burned or provable —
   * oldest first: the ones a vault may have settled without anyone telling Telos.
   */
  openWithdrawals(domain: string | number): TransferRow[] {
    return this.db
      .prepare(
        `SELECT * FROM transfers
         WHERE direction = 'withdrawal' AND domain = ? AND status IN ('burned','provable')
         ORDER BY src_time`,
      )
      // As text: see `pendingDeposits`.
      .all(String(domain)) as TransferRow[];
  }

  countsByStatus(): Record<string, number> {
    const rows = this.db
      .prepare('SELECT direction, status, COUNT(*) AS n FROM transfers GROUP BY direction, status')
      .all() as { direction: string; status: string; n: number }[];
    return Object.fromEntries(rows.map((r) => [`${r.direction}.${r.status}`, r.n]));
  }

  // --- volume -------------------------------------------------------------------

  /**
   * What crossed since `since`, one row per direction, chain, token — and day,
   * when `byDay`.
   *
   * A deposit counts once it is booked; a withdrawal once it is burned, unless
   * it was rolled back, because an expired or refunded one never left. The sum
   * is taken in SQLite's int64 and handed back as text, since WAX volume in
   * canonical units passes 2^53 within weeks.
   */
  volume(since: number, byDay: boolean): VolumeRow[] {
    return this.db
      .prepare(
        `SELECT direction, domain, token,
                ${byDay ? "date(src_time, 'unixepoch')" : 'NULL'} AS day,
                COUNT(*) AS count,
                CAST(SUM(CAST(amount AS INTEGER)) AS TEXT) AS amount,
                COUNT(DISTINCT account) AS accounts,
                COUNT(DISTINCT lower(evm_address)) AS addresses
           FROM transfers WHERE src_time >= ? AND ${CROSSED}
          GROUP BY direction, domain, token, day
          ORDER BY day, direction, domain, token`,
      )
      .all(since) as VolumeRow[];
  }

  /** Distinct Telos accounts and far-side addresses since `since`: per direction, and `all`. */
  people(since: number): Record<Direction | 'all', { accounts: number; addresses: number }> {
    const select = `SELECT COUNT(DISTINCT account) AS accounts, COUNT(DISTINCT lower(evm_address)) AS addresses
                      FROM transfers WHERE src_time >= ? AND ${CROSSED}`;
    const count = (sql: string, ...args: (string | number)[]) =>
      ({ ...(this.db.prepare(sql).get(...args) as { accounts: number; addresses: number }) });
    return {
      deposit: count(`${select} AND direction = ?`, since, 'deposit'),
      withdrawal: count(`${select} AND direction = ?`, since, 'withdrawal'),
      all: count(select, since),
    };
  }

  // --- claims -------------------------------------------------------------------

  recordClaim(trxId: string, owner: string, symbol: string, block: number, at: number): void {
    this.db
      .prepare(
        `INSERT INTO claims (trx_id, owner, symbol, block, at) VALUES (?,?,?,?,?)
         ON CONFLICT(trx_id) DO NOTHING`,
      )
      .run(trxId, owner, symbol, block, at);
  }

  claimsOf(owner: string, limit = 20): { trx_id: string; symbol: string; block: number; at: number }[] {
    return this.db
      .prepare('SELECT trx_id, symbol, block, at FROM claims WHERE owner = ? ORDER BY at DESC LIMIT ?')
      .all(owner, limit) as { trx_id: string; symbol: string; block: number; at: number }[];
  }

  // --- swaps --------------------------------------------------------------------

  /**
   * An order made: its `opened`, which is what says where it came from. Read
   * after its `closed` — both in one page of history — it fills in the row
   * the `closed` began.
   */
  putSwapOpened(r: Pick<SwapRow, 'chain' | 'id' | 'payout_tx' | 'recipient' | 'back' | 'input' | 'least' | 'deadline' | 'opened_at'>): void {
    this.db
      .prepare(
        `INSERT INTO swaps (chain, id, payout_tx, recipient, back, input, least, deadline, opened_at)
         VALUES (?,?,?,?,?,?,?,?,?)
         ON CONFLICT(chain, id) DO UPDATE SET payout_tx = excluded.payout_tx, recipient = excluded.recipient,
           back = excluded.back, input = excluded.input, least = excluded.least, deadline = excluded.deadline,
           opened_at = excluded.opened_at`,
      )
      .run(r.chain, r.id, r.payout_tx, r.recipient, r.back, r.input, r.least, r.deadline, r.opened_at);
  }

  /**
   * An order ended: its `closed`. A payout paid on at once has no `opened`, so
   * its `closed` is the whole order, made in the payout's own transaction.
   */
  putSwapClosed(r: { chain: string; id: number; outcome: string; paid: SwapPayment[]; tx: string; at: number }): void {
    const first = r.paid[0];
    this.db
      .prepare(
        `INSERT INTO swaps (chain, id, payout_tx, recipient, back, input, outcome, paid, closed_tx, opened_at, closed_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(chain, id) DO UPDATE SET outcome = excluded.outcome, paid = excluded.paid,
           closed_tx = excluded.closed_tx, closed_at = excluded.closed_at`,
      )
      .run(r.chain, r.id, r.tx, first?.to ?? '', first?.to ?? '', first?.asset ?? '', r.outcome, JSON.stringify(r.paid),
        r.tx, r.at, r.at);
  }

  /** The withdrawals a transaction on Telos opened, by key: what a swap delivered to another chain. */
  withdrawalsOpenedIn(tx: string): string[] {
    return (this.db
      .prepare(`SELECT key FROM transfers WHERE direction = 'withdrawal' AND src_tx = ? ORDER BY ref`)
      .all(tx) as { key: string }[]).map((r) => r.key);
  }

  /** One order of `chain`'s bridgeroute. */
  swapOf(chain: string, id: number): SwapRow | undefined {
    return this.db.prepare('SELECT * FROM swaps WHERE chain = ? AND id = ?').get(chain, id) as SwapRow | undefined;
  }

  /** The order a payout made, by the payout's transaction. */
  swapByPayout(tx: string): SwapRow | undefined {
    return this.db.prepare('SELECT * FROM swaps WHERE payout_tx = ?').get(tx) as SwapRow | undefined;
  }

  // --- hops ---------------------------------------------------------------------

  /** Recorded once per `bind`; the stream replays blocks, so a second sighting changes nothing. */
  putHop(h: HopRow): void {
    this.db
      .prepare(
        `INSERT INTO hops (id, prev, deposit, quantity, to_domain, to_recipient, back_domain,
            back_recipient, tx, block, at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(h.id, h.prev, h.deposit, h.quantity, h.to_domain, h.to_recipient, h.back_domain,
        h.back_recipient, h.tx, h.block, h.at);
  }

  getHop(id: number): HopRow | undefined {
    return this.db.prepare('SELECT * FROM hops WHERE id = ?').get(id) as HopRow | undefined;
  }

  /** The hop that carried a deposit on. */
  hopOfDeposit(key: string): HopRow | undefined {
    return this.db.prepare('SELECT * FROM hops WHERE deposit = ?').get(key) as HopRow | undefined;
  }

  /** The hop that sent `id` back, once it was voided and recovered. */
  hopAfter(id: number): HopRow | undefined {
    return this.db.prepare('SELECT * FROM hops WHERE prev = ?').get(id) as HopRow | undefined;
  }

  /**
   * Hops the far side voided that nobody has sent back yet: the withdrawal is
   * refunded, and no later hop names it as `prev`.
   */
  awaitingRecover(): HopRow[] {
    return this.db
      .prepare(
        `SELECT h.* FROM hops h JOIN transfers t ON t.key = 'w:' || h.id
         WHERE t.status = 'refunded' AND NOT EXISTS (SELECT 1 FROM hops n WHERE n.prev = h.id)
         ORDER BY h.id`,
      )
      .all() as HopRow[];
  }

  /**
   * Deposits to the hop contract that touch `party` — as the depositor, the
   * recipient over there, or the way back — newest first.
   *
   * Read from the deposits, not from the hops: a journey exists from the moment
   * its deposit is seen on the far chain, a minute or more before the hop opens
   * on Telos. Until then the two ends are only in the memo,
   * `<domain>:<to>|<domain>:<back>`, and they are matched there.
   */
  hopDeposits(q: { hop: string; party?: string; before?: number; limit?: number }): string[] {
    const where = [`d.direction = 'deposit'`, 'd.account = ?'];
    const args: unknown[] = [q.hop];
    if (q.party) {
      const p = q.party.toLowerCase();
      // A swap at the far end names its real recipient only in the hop's third
      // part (`…|<recipient>|<least>|<deadline>`) and, once paid out, in the
      // order bridgeroute made of it; the hop itself goes to bridgeroute.
      where.push(`(lower(d.evm_address) = ? OR h.to_recipient = ? OR h.back_recipient = ? OR s.recipient = ?
        OR lower(d.memo) LIKE ? OR lower(d.memo) LIKE ? OR lower(d.memo) LIKE ? OR lower(d.memo) LIKE ?)`);
      args.push(p, p, p, p, `%:${p}|%`, `%|%:${p}`, `%|%:${p}|%`, `%|%|${p}|%`);
    }
    if (q.before) { where.push('d.src_time < ?'); args.push(q.before); }
    args.push(Math.min(q.limit ?? 50, 500));
    return (this.db
      .prepare(
        `SELECT DISTINCT d.key, d.src_time, d.ref FROM transfers d
           LEFT JOIN hops h ON h.deposit = d.key
           LEFT JOIN transfers w ON w.key = 'w:' || h.id
           LEFT JOIN swaps s ON s.payout_tx = w.dst_tx
         WHERE ${where.join(' AND ')} ORDER BY d.src_time DESC, d.ref DESC LIMIT ?`,
      )
      .all(...(args as any[])) as { key: string }[]).map((r) => r.key);
  }

  // --- proofs -------------------------------------------------------------------

  putProof(key: string, kind: string, body: string): void {
    this.db
      .prepare(
        `INSERT INTO proofs (key, kind, body, bytes, created_at) VALUES (?,?,?,?,?)
         ON CONFLICT(key) DO NOTHING`,
      )
      .run(key, kind, body, Buffer.byteLength(body), Math.floor(Date.now() / 1000));
  }

  getProof(key: string): ProofRow | undefined {
    return this.db.prepare('SELECT * FROM proofs WHERE key = ?').get(key) as ProofRow | undefined;
  }

  hasProof(key: string): boolean {
    return (
      (this.db.prepare('SELECT 1 FROM proofs WHERE key = ?').get(key) as unknown) !== undefined
    );
  }

  /**
   * Drop a proof that has been spent.
   *
   * A credited deposit's nonce can never be used again, so its bundle proves
   * nothing anyone can act on. Withdrawal artifacts are not dropped here even
   * once settled — two kilobytes is cheaper than explaining later why the
   * history has a hole in it.
   */
  dropProof(key: string): void {
    this.db.prepare('DELETE FROM proofs WHERE key = ?').run(key);
  }

  /**
   * Drop every deposit proof whose deposit is booked: its nonce is spent, so
   * the bundle proves nothing anyone can act on. Returns how many went.
   */
  dropSpentDepositProofs(): number {
    return Number(
      this.db
        .prepare(
          `DELETE FROM proofs WHERE key IN (
             SELECT key FROM transfers WHERE direction = 'deposit' AND status IN (${list(BOOKED)}))`,
        )
        .run().changes,
    );
  }

  putCommittee(period: number, keys: string, aggKey: string): void {
    this.db
      .prepare(
        `INSERT INTO committees (period, keys, agg_key, bytes, created_at) VALUES (?,?,?,?,?)
         ON CONFLICT(period) DO NOTHING`,
      )
      .run(period, keys, aggKey, keys.length + aggKey.length, Math.floor(Date.now() / 1000));
  }

  getCommittee(period: number): { keys: string; agg_key: string } | undefined {
    return this.db.prepare('SELECT keys, agg_key FROM committees WHERE period = ?').get(period) as
      | { keys: string; agg_key: string }
      | undefined;
  }

  committeeStats(): { count: number; bytes: number } {
    return this.db
      .prepare('SELECT COUNT(*) AS count, COALESCE(SUM(bytes),0) AS bytes FROM committees')
      .get() as { count: number; bytes: number };
  }

  proofStats(): { count: number; bytes: number } {
    return this.db
      .prepare('SELECT COUNT(*) AS count, COALESCE(SUM(bytes),0) AS bytes FROM proofs')
      .get() as { count: number; bytes: number };
  }

  // --- policies -----------------------------------------------------------------

  putPolicy(generation: number, block: number, body: string): void {
    this.db
      .prepare('INSERT INTO policies (generation, block, body) VALUES (?,?,?) ON CONFLICT(generation) DO NOTHING')
      .run(generation, block, body);
  }

  getPolicy(generation: number): { block: number; body: string } | undefined {
    return this.db.prepare('SELECT block, body FROM policies WHERE generation = ?').get(generation) as
      | { block: number; body: string }
      | undefined;
  }

  /** Every generation published while this store was watching, oldest first. */
  listPolicies(): { generation: number; block: number }[] {
    return this.db.prepare('SELECT generation, block FROM policies ORDER BY generation').all() as {
      generation: number;
      block: number;
    }[];
  }

  // --- handovers ----------------------------------------------------------------

  putHandover(generation: number, block: number, body: string): void {
    this.db
      .prepare('INSERT INTO handovers (generation, block, body) VALUES (?,?,?) ON CONFLICT(generation) DO NOTHING')
      .run(generation, block, body);
  }

  getHandover(generation: number): { block: number; body: string } | undefined {
    return this.db.prepare('SELECT block, body FROM handovers WHERE generation = ?').get(generation) as
      | { block: number; body: string }
      | undefined;
  }

  /** The stored handovers above `generation`, oldest first. */
  handoversAfter(generation: number, limit: number): { generation: number; block: number; body: string }[] {
    return this.db
      .prepare('SELECT generation, block, body FROM handovers WHERE generation > ? ORDER BY generation LIMIT ?')
      .all(generation, limit) as { generation: number; block: number; body: string }[];
  }

  // --- trusted roots ------------------------------------------------------------

  putRoot(
    mroot: string,
    slot: number,
    block: number | null,
    evmBlock: number,
    domain: number | null,
  ): void {
    this.db
      .prepare(
        `INSERT INTO roots (mroot, domain, slot, block, evm_block, seen_at) VALUES (?,?,?,?,?,?)
         ON CONFLICT(mroot, domain) DO UPDATE SET block = COALESCE(excluded.block, roots.block)`,
      )
      .run(mroot.toLowerCase(), domain, slot, block, evmBlock, Math.floor(Date.now() / 1000));
  }

  /**
   * The oldest root at or after `block` that THIS chain trusts — the cheapest
   * one to fold into. Undefined means the withdrawal needs `submitRoot` first.
   */
  earliestRootCovering(
    block: number,
    domain: number,
  ): { mroot: string; block: number } | undefined {
    return this.db
      .prepare(
        'SELECT mroot, block FROM roots WHERE block >= ? AND domain = ? ORDER BY block ASC LIMIT 1',
      )
      .get(block, domain) as { mroot: string; block: number } | undefined;
  }

  rootsWithoutBlock(limit = 20): { mroot: string; slot: number; domain: number | null }[] {
    return this.db
      .prepare('SELECT mroot, slot, domain FROM roots WHERE block IS NULL LIMIT ?')
      .all(limit) as { mroot: string; slot: number; domain: number | null }[];
  }

  rootCount(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM roots').get() as { n: number }).n;
  }

  // --- incidents ----------------------------------------------------------------

  incident(kind: string, detail: string): void {
    this.db
      .prepare('INSERT INTO incidents (at, kind, detail) VALUES (?,?,?)')
      .run(Math.floor(Date.now() / 1000), kind, detail);
    // Keep the tail only; this is a log to look at, not a record to rely on.
    this.db.exec(
      'DELETE FROM incidents WHERE id <= (SELECT MAX(id) - 1000 FROM incidents)',
    );
  }

  recentIncidents(limit = 20): { at: number; kind: string; detail: string }[] {
    return this.db
      .prepare('SELECT at, kind, detail FROM incidents ORDER BY id DESC LIMIT ?')
      .all(limit) as { at: number; kind: string; detail: string }[];
  }

  close(): void {
    this.db.close();
  }
}

/**
 * Which of two statuses is further along.
 *
 * Both chains are rescanned after a restart, and the Antelope side does not know
 * that a withdrawal was released until the refund path closes it. Ordering the
 * states and keeping the later one is what stops a rescan from undoing progress.
 */
const ORDER: TransferStatus[] = [
  'seen',
  'burned',
  'provable',
  'credited',
  'parked',
  'forwarded',
  'bounced',
  'released',
  'expired',
  'refunded',
];

/** A deposit the settlement chain has booked, whatever became of it next. */
export const BOOKED: TransferStatus[] = ['credited', 'parked', 'forwarded', 'bounced'];

/** A withdrawal that has left Telos and was not rolled back. */
export const WITHDRAWN: TransferStatus[] = ['burned', 'provable', 'released'];

const list = (statuses: TransferStatus[]) => statuses.map((s) => `'${s}'`).join(', ');

/** The rows `volume` and `people` count: booked deposits, withdrawals that left. */
const CROSSED = `((direction = 'deposit' AND status IN (${list(BOOKED)}))
               OR (direction = 'withdrawal' AND status IN (${list(WITHDRAWN)})))`;

/** Nothing is left for anyone to do. A parked deposit is still waiting. */
export const SETTLED: TransferStatus[] = ['credited', 'forwarded', 'bounced', 'released', 'refunded'];

function later(a: TransferStatus, b: TransferStatus): TransferStatus {
  return ORDER.indexOf(b) > ORDER.indexOf(a) ? b : a;
}
