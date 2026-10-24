/** `/v1/handovers`: Telos's finalizer-policy handovers, for a light client that lags. */

import { handoverCalls } from '../../../src/near/withdrawal.ts';
import { installPolicyCall, submitRootCall } from '../../../src/sui/withdrawal.ts';
import { status } from './cache.ts';
import type { Deps } from './deps.ts';
import { exact, intParam, json, type Route } from './http.ts';
import { firstNearVault } from './near.ts';

export const handoverRoutes: Route[] = [
  {
    shown: '/v1/handovers?after=<generation>[&limit=50]',
    match: exact('/v1/handovers'),
    handle: async ({ deps, q }) =>
      json(200, await handovers(deps, intParam(q, 'after', 0, 2 ** 32) ?? 0, intParam(q, 'limit', 1, 100) ?? 50), 30),
  },
];

/**
 * Telos's finalizer-policy handovers, stored as they happen: what a light
 * client that lags walks to catch up, oldest first. A generation whose
 * handover could not be built is missing from the list; the next one is
 * signed by it and still verifies against seats held from before.
 */
async function handovers(deps: Deps, after: number, limit: number) {
  // On an instance that shows Sui, each handover also as the two Move calls
  // that walk the Sui client over it.
  const sui = deps.cfg.sui?.length
    ? ((await status(deps)).sources as any[]).find((x) => x.kind === 'sui')?.contracts
    : undefined;
  // And on one that shows NEAR, as the two function calls on the vault (which holds its Telos client).
  const nearVault = await firstNearVault(deps);
  const rows = deps.store.handoversAfter(after, limit).map((h) => {
    const body = JSON.parse(h.body);
    return {
      ...body,
      ...(nearVault ? { nearCalls: handoverCalls(nearVault, body.submitRoot) } : {}),
      ...(sui?.package && sui.telosClient
        ? {
            suiCalls: [
              submitRootCall(sui.package, sui.telosClient, body.submitRoot),
              installPolicyCall(sui.package, sui.telosClient, body.submitRoot.pending.policy),
            ],
          }
        : {}),
    };
  });
  return { handovers: rows, count: rows.length };
}
