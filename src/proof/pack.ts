/**
 * fc::raw::pack, the parts of it a Savanna finality digest needs.
 *
 * Every value below is packed exactly as nodeop packs it, because the digest is
 * a SHA-256 over those bytes — a single wrong byte and the signature check fails
 * with nothing to point at. Integers are little-endian, lengths are LEB128
 * varuints, and fixed-size digests carry no length prefix while BLS keys do.
 *
 * Changed from the Wire original: the block-timestamp epoch is no longer a
 * constant here. Wire counts slots from 2025-01-01 and Antelope from
 * 2000-01-01 — about 1.58 billion slots apart — so a per-chain fact living in a
 * shared module is a loaded gun. It moved to `src/chains/savanna.ts` and the
 * conversion helpers now take the chain.
 */

export class Writer {
  private parts: Uint8Array[] = [];

  u32(v: number): this {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, v >>> 0, true);
    this.parts.push(b);
    return this;
  }

  u64(v: bigint | number): this {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, BigInt(v), true);
    this.parts.push(b);
    return this;
  }

  u16(v: number): this {
    const b = new Uint8Array(2);
    new DataView(b.buffer).setUint16(0, v & 0xffff, true);
    this.parts.push(b);
    return this;
  }

  varuint32(v: number): this {
    const out: number[] = [];
    let value = v >>> 0;
    do {
      let byte = value & 0x7f;
      value >>>= 7;
      if (value) byte |= 0x80;
      out.push(byte);
    } while (value);
    this.parts.push(Uint8Array.from(out));
    return this;
  }

  /** Raw bytes, no length prefix — how a digest_type is packed. */
  raw(bytes: Uint8Array): this {
    this.parts.push(bytes);
    return this;
  }

  /**
   * Length-prefixed bytes — how std::string and a bls public_key are packed.
   *
   * The key one is the BLS public key: 96 bytes preceded by `varuint32(96)`,
   * i.e. a single 0x60. Omitting that prefix produces a finalizer policy digest
   * that is wrong, and therefore a finality digest that is wrong, and therefore
   * a proof that will not verify against anything.
   */
  bytes(b: Uint8Array): this {
    return this.varuint32(b.length).raw(b);
  }

  string(s: string): this {
    return this.bytes(new TextEncoder().encode(s));
  }

  /** An Antelope name: base-32 packed into a uint64. */
  name(value: string): this {
    return this.u64(nameToUint64(value));
  }

  done(): Uint8Array {
    const total = this.parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const p of this.parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  }
}

/**
 * Antelope names, both ways.
 *
 * A name is thirteen characters of a 32-symbol alphabet packed into a uint64,
 * five bits each except the last, which gets four. Both directions are needed
 * and they are inverses: a contract takes `telosTo` as the packed integer, an
 * event emits it as one, and everything a person reads is the string.
 *
 * Kept together so the alphabet is written once. Two copies of a base-32 table
 * that disagree in one entry produce a name that is merely wrong — a valid
 * string for a different account.
 */
const NAME_ALPHABET = '.12345abcdefghijklmnopqrstuvwxyz';

export function nameToUint64(value: string): bigint {
  if (value.length > 13) throw new Error(`name "${value}" is longer than 13 characters`);
  const symbol = (c: string): bigint => {
    const i = NAME_ALPHABET.indexOf(c);
    if (i < 0) throw new Error(`invalid character '${c}' in name "${value}"`);
    return BigInt(i);
  };
  let n = 0n;
  for (let i = 0; i < 12; i++) {
    const c = i < value.length ? symbol(value[i]) : 0n;
    n |= (c & 0x1fn) << BigInt(64 - 5 * (i + 1));
  }
  if (value.length === 13) {
    // The 13th character has four bits: nothing past 'j'. Masking would give a
    // valid name for a different account.
    const c = symbol(value[12]);
    if (c > 0x0fn) throw new Error(`the 13th character of "${value}" cannot come after 'j'`);
    n |= c;
  }
  return n;
}

export function uint64ToName(packed: bigint | string | number): string {
  let n = BigInt(packed);
  const out: string[] = [];
  // The 13th character occupies the low four bits, the other twelve five each.
  out.push(NAME_ALPHABET[Number(n & 0x0fn)]);
  n >>= 4n;
  for (let i = 0; i < 12; i++) {
    out.push(NAME_ALPHABET[Number(n & 0x1fn)]);
    n >>= 5n;
  }
  // Trailing dots are padding, not part of the name; interior ones are.
  return out.reverse().join('').replace(/\.+$/, '');
}

/**
 * A name the ledger stored as eight little-endian bytes of hex — a vault, a
 * recipient, the contract half of an `ext_token` — back to the account name.
 */
export function hexToName(hex: string): string {
  const b = Buffer.from(hex, 'hex');
  if (b.length < 8) throw new Error(`"${hex}" is ${b.length} bytes, not a packed name`);
  return uint64ToName(b.readBigUInt64LE(0));
}

/** Milliseconds per block_timestamp slot. The same on Telos and on Wire. */
export const SLOT_MS = 500;

/** A chain's block-timestamp epoch, in ms. Take it from the chain registry. */
export type SlotEpoch = { blockTimestampEpochMs: number; blockIntervalMs: number };

export function timestampToSlot(chain: SlotEpoch, isoOrMs: string | number): number {
  // Node block timestamps come without a zone but are UTC.
  const ms =
    typeof isoOrMs === 'number'
      ? isoOrMs
      : Date.parse(isoOrMs.endsWith('Z') ? isoOrMs : `${isoOrMs}Z`);
  return Math.round((ms - chain.blockTimestampEpochMs) / chain.blockIntervalMs);
}

export function slotToTimestamp(chain: SlotEpoch, slot: number): string {
  return new Date(chain.blockTimestampEpochMs + slot * chain.blockIntervalMs)
    .toISOString()
    .replace('Z', '');
}

/** A slot as epoch seconds, rounded down: the time a stored row carries. */
export function slotToUnix(chain: SlotEpoch, slot: number): number {
  return Math.floor((chain.blockTimestampEpochMs + slot * chain.blockIntervalMs) / 1000);
}
