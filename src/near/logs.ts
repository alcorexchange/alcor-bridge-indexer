/**
 * The NEAR vault's log lines (contracts/near): `alcor:<kind>:` and the
 * lowercase hex of a borsh struct — u32 lengths, little-endian integers.
 *
 * The deposit and voided lines are what Telos proves; the rest only label a
 * crossing here. Nothing decoded from a log the indexer read off an RPC is
 * trusted for money: Telos checks the deposit line itself against a head its
 * light client accepted.
 */
import { createHash } from 'node:crypto';

/** What Telos knows a NEAR account or token by: sha256 of its id, hex. */
export const nearAddress = (id: string) => createHash('sha256').update(id, 'utf8').digest('hex');

class Borsh {
  private at = 0;
  private readonly b: Buffer;
  constructor(b: Buffer) {
    this.b = b;
  }
  private take(n: number): Buffer {
    if (this.at + n > this.b.length) throw new Error('near log: the struct ends early');
    const out = this.b.subarray(this.at, this.at + n);
    this.at += n;
    return out;
  }
  u32 = () => this.take(4).readUInt32LE(0);
  u64 = () => this.take(8).readBigUInt64LE(0);
  u128 = () => {
    const b = this.take(16);
    return b.readBigUInt64LE(0) | (b.readBigUInt64LE(8) << 64n);
  };
  bool = () => this.take(1)[0] !== 0;
  bytes = () => this.take(this.u32());
  str = () => this.bytes().toString('utf8');
  done() {
    if (this.at !== this.b.length) throw new Error('near log: trailing bytes after the struct');
  }
}

export type NearDeposit = {
  kind: 'deposit';
  /** NEP-141 contract account id, or NEAR. */
  token: string;
  from: string;
  raw: bigint;
  canonical: bigint;
  /** The Antelope account, packed. */
  telosTo: bigint;
  nonce: bigint;
  refundTo: string;
  fillFee: bigint;
  filler: bigint;
  memo: Buffer;
};

export type NearLog =
  | NearDeposit
  | { kind: 'voided'; id: bigint }
  | { kind: 'released'; id: bigint; recipient: string; amount: bigint; fee: bigint }
  | { kind: 'release_failed'; id: bigint }
  | { kind: 'fee_owed'; account: string; token: string; raw: bigint }
  | { kind: 'paused'; deposits: boolean; withdrawals: boolean }
  | { kind: 'policy_set'; generation: number; finalizers: number; threshold: bigint };

/** One log line, decoded; undefined for a line that is not the vault's. */
export function parseNearLog(line: string): NearLog | undefined {
  const m = /^alcor:([a-z_]+):([0-9a-f]*)$/.exec(line);
  if (!m) return undefined;
  const r = new Borsh(Buffer.from(m[2], 'hex'));
  let out: NearLog;
  switch (m[1]) {
    case 'deposit':
      out = {
        kind: 'deposit', token: r.str(), from: r.str(), raw: r.u128(), canonical: r.u64(), telosTo: r.u64(),
        nonce: r.u64(), refundTo: r.str(), fillFee: r.u64(), filler: r.u64(), memo: Buffer.from(r.bytes()),
      };
      break;
    case 'voided':
      out = { kind: 'voided', id: r.u64() };
      break;
    case 'released':
      out = { kind: 'released', id: r.u64(), recipient: r.str(), amount: r.u64(), fee: r.u64() };
      break;
    case 'release_failed':
      out = { kind: 'release_failed', id: r.u64() };
      break;
    case 'fee_owed':
      out = { kind: 'fee_owed', account: r.str(), token: r.str(), raw: r.u128() };
      break;
    case 'paused':
      out = { kind: 'paused', deposits: r.bool(), withdrawals: r.bool() };
      break;
    case 'policy_set':
      out = { kind: 'policy_set', generation: r.u32(), finalizers: r.u32(), threshold: r.u64() };
      break;
    default:
      return undefined;
  }
  r.done();
  return out;
}
