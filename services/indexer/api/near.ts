/** A withdrawal's settlement on NEAR, as the function calls a wallet sends to the vault. */

import { TELOS_HISTORY } from '../../../src/config.ts';
import { isTrusted, knowsKey, nearVaultState } from '../../../src/near/client.ts';
import { settleCalls as nearSettleCalls } from '../../../src/near/withdrawal.ts';
import { fetchRegistrations, type Registration } from '../../../src/savanna/registrations.ts';
import type { WithdrawalArtifact } from '../../../src/savanna/withdrawalArtifact.ts';
import { frozenSubmitRoot } from '../../../src/savanna/withdrawalProof.ts';
import type { TransferRow } from '../db.ts';
import { nearAccountKey, nearRouteOf } from '../nearVault.ts';
import type { Deps } from './deps.ts';
import { fail, type Reply } from './http.ts';

/** The vault of the first NEAR chain this instance shows that the ledger routes to. */
export async function firstNearVault(deps: Deps): Promise<string | undefined> {
  for (const near of deps.cfg.near ?? []) {
    const route = await nearRouteOf(deps.cfg, near.chain.domain).catch(() => undefined);
    if (route) return route.vault;
  }
  return undefined;
}

/**
 * Every key Telos ever registered, with its proof of possession, read from
 * history at most every ten minutes: a key new to Telos arrives about once a day.
 */
let registrations: { at: number; list: Promise<Registration[]> } | undefined;
function registrationsSoon(): Promise<Registration[]> {
  if (registrations && Date.now() - registrations.at < 600_000) return registrations.list;
  const list = fetchRegistrations(TELOS_HISTORY);
  list.catch(() => { registrations = undefined; });
  registrations = { at: Date.now(), list };
  return list;
}

/**
 * A withdrawal's settlement on NEAR, as the function calls a wallet sends to the
 * vault, in order (`near.calls`): `register_key` for each signer key the vault's
 * Telos client does not know yet (with its proof of possession from Telos's
 * `regfinkey` history), `submit_root` unless the root is already trusted, then
 * `release` before the deadline or `expire` after it.
 *
 * `release` names the recipient's account id, whose sha256 the withdrawal
 * carries. The indexer knows it when the vault's logs named that account (a
 * depositor, a refund address, an earlier recipient); otherwise `recipient` is
 * null in the call and the wallet puts in its own account id, which the vault
 * checks against `recipientAddress`.
 *
 * When the client seats an older generation than the one that signed, `catchUp`
 * names the handovers to walk first (`nearCalls` in `/v1/handovers`). A signer
 * key no history holds is listed in `unknownSigners`; the walk teaches it.
 */
export async function nearWithdrawalProof(deps: Deps, row: TransferRow, artifact: WithdrawalArtifact): Promise<Reply> {
  const near = (deps.cfg.near ?? []).find((n) => n.chain.domain === String(row.domain));
  if (!near) return fail(404, 'NOT_FOUND', 'this instance has no endpoint for that NEAR network (NEAR_RPC / NEAR_TESTNET_RPC)');
  const route = await nearRouteOf(deps.cfg, near.chain.domain);
  if (!route) return fail(404, 'NOT_FOUND', `the ledger has no route to ${near.chain.name}`);
  const vault = await nearVaultState(near.rpc, route.vault);
  const release = artifact.release as any;
  const token = String(release.token).replace(/^0x/, '').toLowerCase();
  const asset = vault.assets.find((a) => a.token === token);
  if (!asset) return fail(404, 'NOT_FOUND', `the vault ${route.vault} lists no token with address ${token}`);
  const recipientAddress = String(release.recipient).replace(/^0x/, '').toLowerCase();
  const recipient = deps.store.getMeta(nearAccountKey(recipientAddress)) ?? null;

  const root = frozenSubmitRoot(artifact.submitRoot);
  const signing = Number(root.finality.activeGeneration);
  // The signers: the keys of the signing policy whose bit is set, by keccak id.
  const bits = Buffer.from(root.bits.replace(/^0x/, ''), 'hex');
  const signers = new Set(root.policyKeys
    .filter((_, i) => (bits[i >> 3] >> (i & 7)) & 1)
    .map((k) => k.replace(/^0x/, '').toLowerCase()));
  const known = (await registrationsSoon()).filter((r) => signers.has(r.keyId.replace(/^0x/, '').toLowerCase()));
  const knows = await Promise.all(known.map((r) => knowsKey(near.rpc, route.vault, Buffer.from(r.raw).toString('hex'))));
  const learn = known.filter((_, i) => !knows[i]);
  const unknownSigners = [...signers].filter((id) => !known.some((r) => r.keyId.replace(/^0x/, '').toLowerCase() === id));
  const trusted = await isTrusted(near.rpc, route.vault, root.finality.finalityMroot);
  // The vault releases up to the deadline second and expires only after it.
  const pastDeadline = row.deadline !== null && row.deadline < Math.floor(Date.now() / 1000);

  return {
    code: 200,
    body: {
      key: row.key,
      direction: 'withdrawal',
      chain: near.chain.id,
      burnBlock: artifact.burnBlock,
      rootBlock: artifact.rootBlock,
      vault: artifact.vault,
      status: row.status,
      deadline: row.deadline,
      near: {
        network: near.chain.network,
        vault: route.vault,
        token: asset.tokenId,
        recipient,
        recipientAddress,
        signingGeneration: signing,
        seatedGeneration: vault.client.generation,
        catchUp: vault.client.generation < signing ? `/v1/handovers?after=${vault.client.generation}` : null,
        unknownSigners,
        rootTrusted: trusted,
        action: pastDeadline ? 'expire' : 'release',
        calls: nearSettleCalls({
          vault: route.vault, artifact, submitRoot: root, learn, trusted,
          token: asset.tokenId, recipient, pastDeadline,
        }),
      },
    },
  };
}
