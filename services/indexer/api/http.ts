/**
 * The plumbing every route shares: what a handler gets, what it answers, and how
 * that answer is written. A handler returns a `Reply` and never touches the
 * socket, so the shape of every response is decided in one place.
 */

import type { ServerResponse } from 'node:http';

import type { Deps } from './deps.ts';

/** What a handler is given: the services, the query, what its path pattern captured, who asks, and a header. */
export type Request = {
  deps: Deps;
  q: URLSearchParams;
  params: string[];
  ip: string;
  header: (name: string) => string | undefined;
};

/**
 * JSON with a status code; `maxAge` only for public aggregates shared that long.
 * Or a document. Or a response held open, which the handler writes itself (a stream).
 */
export type Reply =
  | { code: number; body: unknown; maxAge?: number }
  | { code: number; text: string; contentType: string }
  | { open: (res: ServerResponse) => void };

export type Route = {
  /** The path as the route list at the bare root shows it. */
  shown: string;
  /**
   * For whoever runs the bridge rather than whoever builds on it: served the
   * same, but outside the public contract (`docs/openapi.yaml`), free to change.
   */
  operator?: true;
  /** The captured parts of a path this route serves, or null when it does not serve it. */
  match: (path: string) => string[] | null;
  handle: (req: Request) => Reply | Promise<Reply>;
};

/** A route for one fixed path. */
export const exact = (path: string) => (p: string): string[] | null => (p === path ? [] : null);

/** A route for a pattern; each group captured, URI-decoded, and an absent optional group as ''. */
export const pattern = (re: RegExp) => (p: string): string[] | null => {
  const m = re.exec(p);
  return m ? m.slice(1).map((s) => (s === undefined ? '' : decodeURIComponent(s))) : null;
};

export const json = (code: number, body: unknown, maxAge?: number): Reply => ({ code, body, maxAge });

/**
 * Every error a program can branch on. `error` is written for a person and may
 * change; `code` is the contract and only gains values.
 */
export const ERROR_CODES = [
  // A parameter out of range or malformed, a cursor this API did not hand out, a plan or quote refused as asked.
  'INVALID_REQUEST',
  // No such route, transfer, deposit or block.
  'NOT_FOUND',
  // The transfer exists and its proof does not yet: usually "not yet", not a failure.
  'PROOF_NOT_READY',
  // Only GET is served (and OPTIONS, for a browser's preflight).
  'METHOD_NOT_ALLOWED',
  // Too many at once from one address: streams here, new deposit addresses at the courier.
  'RATE_LIMITED',
  // A chain or service this answer needed did not answer. Worth retrying.
  'UPSTREAM_ERROR',
  // Something this instance could not do.
  'INTERNAL_ERROR',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** An error reply: the message, its code, and whatever else helps the caller (a transfer's `status`). */
export const fail = (status: number, code: ErrorCode, message: string, extra: Record<string, unknown> = {}): Reply =>
  json(status, { error: message, code, ...extra });

/** A request the API refuses as asked, answered 400 with the message. */
export class BadRequest extends Error {}

/** A whole-number query parameter between `min` and `max`; undefined when absent. */
export function intParam(q: URLSearchParams, name: string, min: number, max: number): number | undefined {
  const raw = q.get(name);
  if (raw === null || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new BadRequest(`${name} is a whole number from ${min} to ${max}`);
  return n;
}

/** Write a reply. */
export function send(res: ServerResponse, reply: Reply): void {
  if ('open' in reply) return reply.open(res);
  if ('text' in reply) {
    res.writeHead(reply.code, { 'content-type': reply.contentType, 'cache-control': 'no-store' });
    return void res.end(reply.text);
  }
  const text = JSON.stringify(reply.body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 1);
  res.writeHead(reply.code, {
    'content-type': 'application/json; charset=utf-8',
    // Everything else here answers "what is true right now", and the queue of
    // things waiting to be signed is the worst possible thing to serve from a
    // cache — a stale one shows work that is already done, or hides work that
    // is not.
    'cache-control': reply.maxAge ? `public, max-age=${reply.maxAge}` : 'no-store',
  });
  res.end(text);
}
