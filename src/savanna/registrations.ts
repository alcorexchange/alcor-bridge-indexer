/**
 * The finalizer keys Telos has registered, and whether an EVM light client knows one.
 *
 * `TelosLightClient` checks a certificate only if every signer's key is in its
 * `pubkeyOf`, and it learns keys independently of the policy: `registerKey`
 * takes the key and its proof of possession, and anyone may call it. Telos
 * checks that proof in `regfinkey` and does not keep it, but the historical
 * action carries it, and Hyperion serves that over plain HTTP.
 *
 * Shared by the script that registers what is missing and by the indexer,
 * which tells a front end what is missing so a user can register it.
 */

import { keccak_256 } from '@noble/hashes/sha3.js';

import type { Exec } from '../evm/exec.ts';
import { selector } from '../evm/exec.ts';
import { fetchJson } from '../net/fetchJson.ts';
import {
  decodeBlsPublicKey,
  decodeBlsSignature,
  encodeG1ToAntelope,
  encodeG2ToAntelope,
} from './encoding.ts';

export type Registration = {
  /** The producer that registered it. */
  finalizer: string;
  /** keccak of the raw key: the identity `TelosLightClient` stores it under. */
  keyId: string;
  /** `registerKey`'s first argument: 96 bytes, affine little-endian. */
  raw: Uint8Array;
  /** Its second: the 192-byte proof of possession. */
  pop: Uint8Array;
};

const PAGE = 500;

const hex = (b: Uint8Array) => '0x' + Buffer.from(b).toString('hex');

/** keccak of a raw 96-byte key, as `TelosLightClient` names it. */
export const keyIdOf = (raw: Uint8Array): string => hex(keccak_256(raw));

/** The same identity for a `PUB_BLS_…` string, as RPC serves a policy. */
export const keyIdOfPublicKey = (pub: string): string =>
  keyIdOf(encodeG1ToAntelope(decodeBlsPublicKey(pub)));

/**
 * Every key ever registered through `regfinkey`, the first registration of each.
 *
 * Hyperion endpoints are tried in order: one answering 500 for a minute is a
 * normal afternoon, and a second host is what gets past it.
 */
export async function fetchRegistrations(history: string[]): Promise<Registration[]> {
  if (!history.length) throw new Error('no Hyperion endpoint configured (TELOS_HISTORY)');
  const failures: string[] = [];
  for (const host of history) {
    try {
      return registrationsFrom(await allRegfinkeys(host.replace(/\/$/, '')));
    } catch (err) {
      failures.push(`${host}: ${(err as Error).message}`);
    }
  }
  throw new Error(`no Hyperion endpoint served the registrations — ${failures.join('; ')}`);
}

async function allRegfinkeys(host: string): Promise<any[]> {
  const out: any[] = [];
  for (let skip = 0; ; skip += PAGE) {
    const url = `${host}/v2/history/get_actions?act.name=regfinkey&sort=asc&limit=${PAGE}&skip=${skip}`;
    const body = (await fetchJson(url)) as { actions?: any[] };
    // A node that answers without `actions` is answering about something else —
    // history off, or a proxy in front of it.
    if (!Array.isArray(body.actions)) throw new Error('no actions array');
    out.push(...body.actions);
    if (body.actions.length < PAGE) return out;
  }
}

function registrationsFrom(actions: any[]): Registration[] {
  const byKey = new Map<string, Registration>();
  for (const a of actions) {
    const d = a.act?.data;
    if (!d?.finalizer_key || !d?.proof_of_possession) continue;
    // Both arrive as `PUB_BLS_…` / `SIG_BLS_…`; the contract wants the raw affine
    // little-endian bytes those strings encode.
    const raw = encodeG1ToAntelope(decodeBlsPublicKey(d.finalizer_key));
    const pop = encodeG2ToAntelope(decodeBlsSignature(d.proof_of_possession));
    const keyId = keyIdOf(raw);
    if (!byKey.has(keyId)) byKey.set(keyId, { finalizer: d.finalizer_name, keyId, raw, pop });
  }
  return [...byKey.values()];
}

/** Whether `lightClient` already holds the key: `pubkeyOf` is empty until it does. */
export async function knowsKey(exec: Exec, lightClient: string, keyId: string): Promise<boolean> {
  const data = selector('pubkeyOf(bytes32)') + keyId.replace(/^0x/, '');
  const ret: string = await exec.rpc('eth_call', [{ to: lightClient, data }, 'latest']);
  // ABI `bytes`: offset word, then the length word.
  return BigInt('0x' + ret.slice(2 + 64, 2 + 128)) !== 0n;
}

/** `registerKey`'s arguments, hex, in order. */
export const registerKeyArgs = (r: Registration): [string, string] => [hex(r.raw), hex(r.pop)];
