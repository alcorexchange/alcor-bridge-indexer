/**
 * Heimdall, read and re-encoded into the arguments `polylightcl` takes.
 *
 * Everything the contract will check is checked here first, with the same
 * encodings as the contract's: a header's hash
 * against its commit's block id, a validator set against `validators_hash`, a
 * precommit against the member it claims to be from, and a milestone's ICS23
 * proofs against `app_hash`. So a format change at Polygon shows up here as a
 * named mismatch on the first proof, not as a transaction the chain refuses for
 * reasons nobody can read.
 *
 * Endpoints come from the registry (`src/chains/evm.ts`, `heimdall`), tried in
 * order.
 */

import { sha256 } from '@noble/hashes/sha2';
import { keccak_256 } from '@noble/hashes/sha3';
import { secp256k1 } from '@noble/curves/secp256k1';

import type { EvmChain } from '../chains/evm.ts';
import { fetchJson } from '../net/fetchJson.ts';
import { fetchHeader, toHex } from '../bsc/header.ts';

export type Heimdall = NonNullable<EvmChain['heimdall']>;

export function heimdallOf(chain: EvmChain): Heimdall {
  if (!chain.heimdall) throw new Error(`${chain.id} has no Heimdall endpoints in the registry`);
  return chain.heimdall;
}

async function firstOk(urls: string[], path: string): Promise<any> {
  let last: unknown;
  for (const base of urls) {
    try {
      return await fetchJson(`${base}/${path}`);
    } catch (err) {
      last = err;
    }
  }
  throw last;
}

/** CometBFT RPC: the `result` of a GET. */
export async function comet(h: Heimdall, path: string): Promise<any> {
  const j = await firstOk(h.comet, path);
  if (j.error) throw new Error(`${path}: ${JSON.stringify(j.error)}`);
  return j.result;
}

export const rest = (h: Heimdall, path: string): Promise<any> => firstOk(h.rest, path);

export async function latestHeight(h: Heimdall): Promise<number> {
  return Number((await comet(h, 'status')).sync_info.latest_block_height);
}

// --- bytes and protobuf, the same encodings the contract uses ---------------------------

const unhex = (s: string): Uint8Array => Uint8Array.from(Buffer.from(s.replace(/^0x/, ''), 'hex'));
const b64 = (s: string): Uint8Array => Uint8Array.from(Buffer.from(s, 'base64'));
const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

function varint(v: bigint | number): Uint8Array {
  let x = BigInt(v);
  const out: number[] = [];
  do { let c = Number(x & 0x7fn); x >>= 7n; if (x) c |= 0x80; out.push(c); } while (x);
  return Uint8Array.from(out);
}
const pbUint = (f: number, v: bigint | number) => (BigInt(v) ? concat(varint(f << 3), varint(v)) : new Uint8Array());
const pbBytes = (f: number, b: Uint8Array) => (b.length ? concat(varint((f << 3) | 2), varint(b.length), b) : new Uint8Array());
/** A non-nullable embedded message: written even when empty (see cometbft.hpp `put_message`). */
const pbMessage = (f: number, b: Uint8Array) => concat(varint((f << 3) | 2), varint(b.length), b);
function pbSfixed64(f: number, v: bigint | number): Uint8Array {
  if (!BigInt(v)) return new Uint8Array();
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(v));
  return concat(varint((f << 3) | 1), b);
}

type Field = { n: number; w: number; v?: bigint; b?: Uint8Array };
function fields(b: Uint8Array): Field[] {
  const out: Field[] = [];
  let at = 0;
  const read = (): bigint => {
    let v = 0n, s = 0n;
    for (;;) { const c = b[at++]; v |= BigInt(c & 0x7f) << s; s += 7n; if (!(c & 0x80)) return v; }
  };
  while (at < b.length) {
    const key = read();
    const n = Number(key >> 3n), w = Number(key & 7n);
    if (w === 0) out.push({ n, w, v: read() });
    else if (w === 2) { const len = Number(read()); out.push({ n, w, b: b.subarray(at, at + len) }); at += len; }
    else throw new Error(`protobuf wire type ${w}`);
  }
  return out;
}
const field = (fs: Field[], n: number) => fs.find((f) => f.n === n);

function merkle(items: Uint8Array[]): Uint8Array {
  if (items.length === 1) return sha256(concat(Uint8Array.of(0), items[0]));
  let k = 1;
  while (k * 2 < items.length) k *= 2;
  return sha256(concat(Uint8Array.of(1), merkle(items.slice(0, k)), merkle(items.slice(k))));
}

// --- headers and commits ------------------------------------------------------------------

function timestamp(iso: string): { seconds: number; nanos: number } {
  const m = iso.match(/^(.*?)(?:\.(\d+))?Z$/);
  if (!m) throw new Error(`timestamp ${iso}`);
  return { seconds: Math.floor(Date.parse(m[1] + 'Z') / 1000), nanos: Number((m[2] ?? '0').padEnd(9, '0').slice(0, 9)) };
}
const tsProto = (t: { seconds: number; nanos: number }) => concat(pbUint(1, t.seconds), pbUint(2, t.nanos));

type BlockId = { hash: string; parts: { total: number; hash: string } };
const partsProto = (p: BlockId['parts']) => concat(pbUint(1, p.total), pbBytes(2, unhex(p.hash)));
const blockIdProto = (id: BlockId) => concat(pbBytes(1, unhex(id.hash)), pbMessage(2, partsProto(id.parts)));

/** The header as `polylightcl` takes it: `comet::header`, field for field. */
export type HeaderArgs = {
  version_block: number; version_app: number; chain_id: string; height: number;
  time_seconds: number; time_nanos: number;
  last_block_hash: string; last_block_parts: { total: number; hash: string };
  last_commit_hash: string; data_hash: string; validators_hash: string; next_validators_hash: string;
  consensus_hash: string; app_hash: string; last_results_hash: string; evidence_hash: string; proposer_address: string;
};

export function headerArgs(h: any): HeaderArgs {
  const t = timestamp(h.time);
  const lc = (s: string) => (s ?? '').toLowerCase();
  return {
    version_block: Number(h.version.block), version_app: Number(h.version.app ?? 0),
    chain_id: h.chain_id, height: Number(h.height),
    time_seconds: t.seconds, time_nanos: t.nanos,
    last_block_hash: lc(h.last_block_id.hash),
    last_block_parts: { total: Number(h.last_block_id.parts.total), hash: lc(h.last_block_id.parts.hash) },
    last_commit_hash: lc(h.last_commit_hash), data_hash: lc(h.data_hash),
    validators_hash: lc(h.validators_hash), next_validators_hash: lc(h.next_validators_hash),
    consensus_hash: lc(h.consensus_hash), app_hash: lc(h.app_hash),
    last_results_hash: lc(h.last_results_hash), evidence_hash: lc(h.evidence_hash),
    proposer_address: lc(h.proposer_address),
  };
}

export function headerHash(h: HeaderArgs): Uint8Array {
  const bv = (s: string) => pbBytes(1, unhex(s));
  return merkle([
    concat(pbUint(1, h.version_block), pbUint(2, h.version_app)),
    pbBytes(1, new TextEncoder().encode(h.chain_id)),
    pbUint(1, h.height),
    tsProto({ seconds: h.time_seconds, nanos: h.time_nanos }),
    blockIdProto({ hash: h.last_block_hash, parts: h.last_block_parts }),
    bv(h.last_commit_hash), bv(h.data_hash), bv(h.validators_hash), bv(h.next_validators_hash),
    bv(h.consensus_hash), bv(h.app_hash), bv(h.last_results_hash), bv(h.evidence_hash), bv(h.proposer_address),
  ]);
}

export type Member = { address: string; pubkey: string; power: bigint };

/** The set that signs `height`, in its own order, checked against the header's hash. */
export async function validatorSet(h: Heimdall, height: number, expectHash?: string): Promise<Member[]> {
  const out: Member[] = [];
  for (let page = 1; ; page++) {
    const r = await comet(h, `validators?height=${height}&per_page=100&page=${page}`);
    for (const v of r.validators) {
      if (v.pub_key.type !== 'cometbft/PubKeySecp256k1eth') throw new Error(`validator key type ${v.pub_key.type}`);
      out.push({ address: v.address.toLowerCase(), pubkey: hex(b64(v.pub_key.value)), power: BigInt(v.voting_power) });
    }
    if (out.length >= Number(r.total)) break;
  }
  if (expectHash) {
    const got = hex(validatorsHash(out));
    if (got !== expectHash.toLowerCase()) throw new Error(`set at ${height} hashes to ${got}, header says ${expectHash}`);
  }
  return out;
}

export function validatorsHash(set: Member[]): Uint8Array {
  return merkle(set.map((v) => concat(pbBytes(1, pbBytes(3, unhex(v.pubkey))), pbUint(2, v.power))));
}

export const validatorArgs = (set: Member[]) => set.map((v) => ({ pubkey: v.pubkey, power: Number(v.power) }));

function voteSignBytes(height: number, round: number, id: BlockId, t: { seconds: number; nanos: number }, chainId: string) {
  const vote = concat(pbUint(1, 2), pbSfixed64(2, height), pbSfixed64(3, round), pbBytes(4, blockIdProto(id)),
    pbMessage(5, tsProto(t)), pbBytes(6, new TextEncoder().encode(chainId)));
  return concat(varint(vote.length), vote);
}

function recoverAddress(digest: Uint8Array, sig: Uint8Array): string {
  const s = secp256k1.Signature.fromCompact(sig.subarray(0, 64)).addRecoveryBit(sig[64]);
  return hex(keccak_256(s.recoverPublicKey(digest).toRawBytes(false).subarray(1)).subarray(12));
}

export type CommitArgs = {
  header: HeaderArgs;
  round: number;
  parts: { total: number; hash: string };
  precommits: { index: number; time_seconds: number; time_nanos: number; sig: string }[];
};

/**
 * A header and enough of its precommits to pass two thirds, largest first.
 *
 * `set` is the set the contract will count with — the trusted one. Every
 * signature is recovered here against the member at its index before it is
 * offered; fewer signatures is less CPU on Telos, and the contract needs only
 * the quorum.
 */
export async function commitArgs(h: Heimdall, height: number, set: Member[]): Promise<CommitArgs> {
  const sh = (await comet(h, `commit?height=${height}`)).signed_header;
  const header = headerArgs(sh.header);
  const id: BlockId = { hash: sh.commit.block_id.hash.toLowerCase(), parts: { total: Number(sh.commit.block_id.parts.total), hash: sh.commit.block_id.parts.hash.toLowerCase() } };
  if (hex(headerHash(header)) !== id.hash) throw new Error(`header ${height} re-encodes to another hash than its commit names`);
  if (header.chain_id !== h.chainId) throw new Error(`header ${height} is for ${header.chain_id}, not ${h.chainId}`);
  if (sh.commit.signatures.length !== set.length) throw new Error(`commit ${height} has ${sh.commit.signatures.length} slots, the set ${set.length}`);

  const round = Number(sh.commit.round);
  const signed = sh.commit.signatures
    .map((s: any, index: number) => ({ s, index }))
    .filter(({ s }: any) => s.block_id_flag === 2)
    .map(({ s, index }: any) => {
      const t = timestamp(s.timestamp);
      const sig = b64(s.signature);
      if (sig.length !== 65 || sig[64] > 1) throw new Error(`precommit ${index} at ${height}: unexpected signature shape`);
      const msg = voteSignBytes(header.height, round, id, t, h.chainId);
      if (recoverAddress(keccak_256(msg), sig) !== set[index].address) throw new Error(`precommit ${index} at ${height} does not recover to its member`);
      return { index, time_seconds: t.seconds, time_nanos: t.nanos, sig: hex(sig), power: set[index].power };
    });

  const total = set.reduce((a, v) => a + v.power, 0n);
  let power = 0n;
  const chosen = [];
  for (const p of [...signed].sort((a, b) => (a.power > b.power ? -1 : a.power < b.power ? 1 : 0))) {
    chosen.push(p);
    power += p.power;
    if (power * 3n > total * 2n) break;
  }
  if (power * 3n <= total * 2n) throw new Error(`commit ${height}: only ${power} of ${total} signed`);
  chosen.sort((a, b) => a.index - b.index);
  return {
    header, round, parts: id.parts,
    precommits: chosen.map(({ index, time_seconds, time_nanos, sig }) => ({ index, time_seconds, time_nanos, sig })),
  };
}

// --- milestones out of state --------------------------------------------------------------

export type Existence = { leaf_prefix: string; path: { prefix: string; suffix: string }[] };

function existence(op: Uint8Array): { key: Uint8Array; value: Uint8Array; proof: Existence; root: Uint8Array } {
  const exist = fields(field(fields(op), 1)!.b!);
  const key = field(exist, 1)!.b!, value = field(exist, 2)!.b!;
  const leaf = fields(field(exist, 3)!.b!);
  const prefix = field(leaf, 5)?.b ?? new Uint8Array();
  let node = sha256(concat(prefix, varint(key.length), key, varint(32), sha256(value)));
  const path = exist.filter((f) => f.n === 4).map((f) => {
    const inner = fields(f.b!);
    const p = field(inner, 2)?.b ?? new Uint8Array(), s = field(inner, 3)?.b ?? new Uint8Array();
    node = sha256(concat(p, node, s));
    return { prefix: hex(p), suffix: hex(s) };
  });
  return { key, value, proof: { leaf_prefix: hex(prefix), path }, root: node };
}

export const milestoneKey = (n: number) => concat(Uint8Array.of(0x81), unhex(n.toString(16).padStart(16, '0')));

export type Milestone = { number: number; start: number; end: number; hash: string };

export async function milestone(h: Heimdall, n: number): Promise<Milestone> {
  const m = (await rest(h, `milestones/${n}`)).milestone;
  return { number: n, start: Number(m.start_block), end: Number(m.end_block), hash: '0x' + hex(b64(m.hash)) };
}

export async function milestoneCount(h: Heimdall): Promise<number> {
  return Number((await rest(h, 'milestones/count')).count);
}

/** The first milestone whose range ends at or after `block`; it finalizes `block`. */
export async function milestoneCovering(h: Heimdall, block: number): Promise<Milestone> {
  let hi = await milestoneCount(h);
  const top = await milestone(h, hi);
  if (top.end < block) throw new Error(`Bor ${block} is not under a milestone yet (latest ends at ${top.end})`);
  let lo = Math.max(1, hi - 64);
  while ((await milestone(h, lo)).end >= block && lo > 1) lo = Math.max(1, lo - (hi - lo) * 4);
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if ((await milestone(h, mid)).end >= block) hi = mid; else lo = mid;
  }
  return milestone(h, hi);
}

export type MilestoneArgs = {
  commit: CommitArgs; number: number;
  value: string; iavl: Existence; next_value: string; next_iavl: Existence; simple: Existence;
};

function decodeMilestone(n: number, value: Uint8Array): Milestone {
  const m = fields(value);
  return { number: n, start: Number(field(m, 2)?.v ?? 0n), end: Number(field(m, 3)!.v), hash: '0x' + hex(field(m, 4)!.b!) };
}

/** One milestone's IAVL proof from the state at `height`, and the store root it folds to. */
async function storedMilestone(h: Heimdall, n: number, height: number) {
  const key = milestoneKey(n);
  const q = (await comet(h, `abci_query?path=%22/store/milestone/key%22&data=0x${hex(key)}&height=${height}&prove=true`)).response;
  if (Number(q.code) !== 0 || !q.value) throw new Error(`milestone ${n} at ${height}: ${q.log || 'no value'}`);
  if (Number(q.height) !== height) throw new Error(`asked for state at ${height}, got ${q.height}`);
  const [iavlOp, simpleOp] = q.proofOps.ops.map((o: any) => b64(o.data));
  const iavl = existence(iavlOp), simple = existence(simpleOp);
  if (hex(iavl.key) !== hex(key) || hex(iavl.value) !== hex(b64(q.value))) throw new Error('iavl proof is for another key');
  if (new TextDecoder().decode(simple.key) !== 'milestone' || hex(simple.value) !== hex(iavl.root)) throw new Error('simple proof does not carry the milestone store');
  return { iavl, simple, milestone: decodeMilestone(n, iavl.value) };
}

/**
 * Milestones `n` and `n + 1` as stored in the state at `height`, with the commit
 * of the header that carries that state's app_hash (height + 1). The second must
 * start where the first ends — the contract's rule, checked here first.
 */
export async function milestoneArgs(h: Heimdall, n: number, height: number, set: Member[]): Promise<{ args: MilestoneArgs; milestone: Milestone; next: Milestone }> {
  const first = await storedMilestone(h, n, height);
  const second = await storedMilestone(h, n + 1, height);
  if (hex(first.iavl.root) !== hex(second.iavl.root)) throw new Error(`milestones ${n} and ${n + 1} fold to different store roots`);
  if (second.milestone.start !== first.milestone.end + 1) {
    throw new Error(`milestone ${n + 1} starts at ${second.milestone.start}, not right after ${n}'s end ${first.milestone.end}`);
  }

  const commit = await commitArgs(h, height + 1, set);
  if (hex(first.simple.root) !== commit.header.app_hash) throw new Error(`milestone ${n}: state root does not match app_hash of ${height + 1}`);

  return {
    args: {
      commit, number: n,
      value: hex(first.iavl.value), iavl: first.iavl.proof,
      next_value: hex(second.iavl.value), next_iavl: second.iavl.proof,
      simple: first.simple.proof,
    },
    milestone: first.milestone,
    next: second.milestone,
  };
}

/** Bor headers from `from` up to `to`, re-encoded and checked by hash, as `proveroot` wants them. */
export async function borChain(exec: string[], from: number, to: number): Promise<{ rlp: string[]; topHash: string }> {
  const rlp: string[] = [];
  let topHash = '';
  for (let n = from; n <= to; n++) {
    const hdr = await fetchHeader(exec, n);
    rlp.push(toHex(hdr.rlp).slice(2));
    topHash = hdr.hash;
  }
  return { rlp, topHash };
}
