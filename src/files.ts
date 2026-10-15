/** Writing state files that a crash must not leave half-written. */

import { renameSync, writeFileSync } from 'node:fs';

/**
 * Write `value` as JSON to `path` atomically: to a temporary file beside it,
 * then renamed over it, so a killed process leaves the old file or the new one
 * and never half of either.
 */
export function writeJsonAtomic(path: string, value: unknown): void {
  const tmp = path + '.tmp';
  writeFileSync(tmp, JSON.stringify(value, null, 1));
  renameSync(tmp, path);
}
