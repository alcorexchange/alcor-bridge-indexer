/**
 * `docs/openapi.yaml` is the public contract, and it describes this server: every
 * public route is in it, nothing in it is missing here, and its error codes are
 * the ones the API answers with. The shapes themselves are pinned by
 * `api.golden.json`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ROUTES } from '../services/indexer/api/index.ts';
import { ERROR_CODES } from '../services/indexer/api/http.ts';

const SPEC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../docs/openapi.yaml'), 'utf8');

/** Served by the courier under the same base URL, not by this process. */
const COURIER = ['/v1/deposit-addresses', '/v1/deposit-addresses/{address}', '/v1/fees'];

/** `/v1/hops/<key>?x=` as OpenAPI writes it: `/v1/hops/{key}`. */
const asSpec = (shown: string) => shown.replace(/\?.*$/, '').replace(/<([^>]+)>/g, '{$1}');

test('every public route is in the contract, and the contract names no route this server lacks', () => {
  const inSpec = [...SPEC.matchAll(/^ {2}(\/\S*):\s*$/gm)].map((m) => m[1]).sort();
  const served = [...ROUTES.filter((r) => !r.operator).map((r) => asSpec(r.shown)), ...COURIER].sort();
  assert.deepEqual(inSpec, served);
});

test('the contract lists exactly the error codes the API answers with', () => {
  const listed = /ErrorCode:[\s\S]*?enum: \[([^\]]+)\]/.exec(SPEC)?.[1].split(',').map((s) => s.trim());
  assert.deepEqual(listed, [...ERROR_CODES]);
});
