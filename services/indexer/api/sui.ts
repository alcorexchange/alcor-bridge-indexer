/** A withdrawal's release on Sui, as the Move calls a wallet makes. */

import type { WithdrawalArtifact } from '../../../src/savanna/withdrawalArtifact.ts';
import { frozenSubmitRoot } from '../../../src/savanna/withdrawalProof.ts';
import { clientState, vaultState, type VaultState } from '../../../src/sui/client.ts';
import { settleCall, submitRootCall } from '../../../src/sui/withdrawal.ts';
import type { TransferRow } from '../db.ts';
import type { Deps } from './deps.ts';
import { fail, type Reply } from './http.ts';

/** A Sui vault read once a minute: its package, client and coins change only by an owner's hand. */
const suiVaults = new Map<string, { at: number; state: Promise<VaultState> }>();
function suiVaultSoon(graphql: string[], vault: string): Promise<VaultState> {
  const hit = suiVaults.get(vault);
  if (hit && Date.now() - hit.at < 60_000) return hit.state;
  const state = vaultState(graphql, vault);
  state.catch(() => suiVaults.delete(vault));
  suiVaults.set(vault, { at: Date.now(), state });
  return state;
}

/**
 * A withdrawal's release on Sui, as the Move calls a wallet makes: the root
 * first (`submit_root_entry`, a root already trusted is trusted again), then
 * `release_entry<coin>` before the deadline or `expire_entry` after it. Both in
 * one programmable transaction is the usual way.
 *
 * The client must know every signer and should seat the generation that signed:
 * when it is behind, `catchUp` names the handovers to walk first, each a
 * `submit_root_entry` and an `install_policy` (see `/v1/handovers`).
 */
export async function suiWithdrawalProof(deps: Deps, row: TransferRow, artifact: WithdrawalArtifact): Promise<Reply> {
  const sui = deps.cfg.sui?.[0];
  if (!sui) return fail(404, 'NOT_FOUND', 'this instance has no Sui endpoint (SUI_GRAPHQL)');
  const vault = await suiVaultSoon(sui.graphql, artifact.vault);
  const token = String((artifact.release as any).token).replace(/^0x/, '').toLowerCase();
  const coin = vault.assets.find((a) => a.token === token);
  if (!coin) return fail(404, 'NOT_FOUND', `the vault ${artifact.vault} lists no coin with token ${token}`);
  const client = await clientState(sui.graphql, vault.telosClient);
  const root = frozenSubmitRoot(artifact.submitRoot);
  const signing = Number(root.finality.activeGeneration);
  // The newest version of the vault's package: an upgrade retires the code before it.
  const ids = { package: vault.callPackage, telosClient: vault.telosClient, vault: vault.vault, coinType: '0x' + coin.coinType };
  return {
    code: 200,
    body: {
      key: row.key,
      direction: 'withdrawal',
      chain: sui.chain.id,
      burnBlock: artifact.burnBlock,
      rootBlock: artifact.rootBlock,
      vault: artifact.vault,
      status: row.status,
      deadline: row.deadline,
      sui: {
        ...ids,
        signingGeneration: signing,
        seatedGeneration: client.generation,
        catchUp: client.generation < signing ? `/v1/handovers?after=${client.generation}` : null,
        calls: {
          submitRoot: submitRootCall(ids.package, ids.telosClient, root),
          release: settleCall('release', ids, artifact),
          expire: settleCall('expire', ids, artifact),
        },
      },
    },
  };
}
