/**
 * Hex <-> bytes, in one place so the 0x-prefix rule never differs by caller.
 *
 * None of these changes case. Where a comparison needs one spelling — a root
 * read from a file against one computed here — the caller says so with
 * `.toLowerCase()`, so it is visible which comparisons depend on it.
 */
export const toHex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
/** Bytes as an EVM call or event spells them. */
export const toHex0x = (b: Uint8Array): string => `0x${toHex(b)}`;
export const fromHex = (s: string): Uint8Array => Uint8Array.from(Buffer.from(s.replace(/^0x/, ''), 'hex'));

/**
 * Drop a leading 0x. Beacon and JSON-RPC responses carry it; the Wire SDK
 * rejects it outright ("Expected hex string"), so anything crossing into an
 * action's arguments goes through here.
 */
export const bare = (s: string): string => s.replace(/^0x/, '');

/** Add a leading 0x unless it is there: how an EVM call or event spells hex. */
export const hex0x = (s: string): string => (s.startsWith('0x') ? s : `0x${s}`);
