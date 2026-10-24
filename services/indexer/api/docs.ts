import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fail, type Route } from './http.ts';

/**
 * The documents, served from the API they describe.
 *
 * The repository is private, so a GitHub link is a link most of the people who
 * need these cannot open. Serving them here makes them public to exactly whoever
 * can already call the API, and makes it impossible for a document to describe a
 * version other than the one answering — they ship together.
 *
 *   /docs           the front-end walkthrough and every endpoint
 *   /docs/bot       the same bridge from a bot's side: what to sign on each chain
 *   /openapi.yaml   the public contract, for a program or a client generator
 */
const DOCS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../docs');
const DOCS: Record<string, { file: string; contentType: string }> = {
  '/docs': { file: 'API.md', contentType: 'text/markdown; charset=utf-8' },
  '/docs/bot': { file: 'BOT-INTEGRATION.md', contentType: 'text/markdown; charset=utf-8' },
  '/openapi.yaml': { file: 'openapi.yaml', contentType: 'application/yaml; charset=utf-8' },
};
const docsCache = new Map<string, string>();

function docs(path: string): string {
  let text = docsCache.get(path);
  if (text === undefined) {
    try {
      text = readFileSync(join(DOCS_DIR, DOCS[path].file), 'utf8');
    } catch {
      text = '';
    }
    docsCache.set(path, text);
  }
  return text;
}

export const docRoutes: Route[] = Object.keys(DOCS).map((path) => ({
  shown: path,
  match: (p: string) => (p === path ? [] : null),
  handle: () => {
    const text = docs(path);
    if (!text) return fail(404, 'NOT_FOUND', 'this build carries no documentation');
    return { code: 200, text, contentType: DOCS[path].contentType };
  },
}));
