/**
 * Environment variables a process cannot run without.
 *
 * The registries hold public facts only — chain ids, contract accounts, public
 * endpoints. Where a deployment's own nodes are (a state-history socket above
 * all, which nobody serves publicly) is the operator's to say, so a missing one
 * stops the process at start with its name rather than dialing a guess.
 */
export function requiredEnv(name: string, what: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not set: ${what}`);
  return value;
}
