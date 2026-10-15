/**
 * JSON fetch with a proxy fallback.
 *
 * Some upstreams (Cloudflare-fronted beacon endpoints in particular) accept a
 * connection, serve small bodies fine, then stall forever on a large one — Node's
 * fetch reports `ETIMEDOUT` / `terminated` after ~11s while curl through a proxy
 * gets the same body in under a second. Rather than routing everything through the
 * proxy, each request goes out direct first and only retries through the local
 * HTTP CONNECT proxy (`FALLBACK_PROXY`) when it fails that way — if one is set.
 *
 * The retry needs undici's own `fetch`: a ProxyAgent from the npm package is a
 * different class than the one Node's global fetch accepts, and passing it there
 * fails with UND_ERR_INVALID_ARG.
 */
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

import { ProxyAgent, fetch as undiciFetch } from 'undici';

/** An HTTP CONNECT proxy to retry a stalled request through. Unset: no retry. */
const PROXY = process.env.FALLBACK_PROXY?.trim() || undefined;
/**
 * Send everything through the proxy from the start instead of trying direct
 * first. Worth setting behind DPI, where a direct request does not fail fast —
 * it hangs, and the fallback only fires after the stall.
 */
const PROXY_ALL = process.env.PROXY_ALL === '1';
if (PROXY_ALL && !PROXY) throw new Error('PROXY_ALL=1 needs FALLBACK_PROXY, the proxy to send everything through');
let agent: ProxyAgent | undefined;

/** Errors that mean "the body never arrived", as opposed to a real HTTP answer. */
function isStall(err: unknown): boolean {
  const cause = (err as { cause?: { code?: string } })?.cause;
  const code = cause?.code ?? (err as { code?: string })?.code;
  return code === 'ETIMEDOUT' || code === 'UND_ERR_BODY_TIMEOUT' || code === 'ECONNRESET' ||
         (err as Error)?.message === 'terminated';
}

/**
 * A response that arrived and was not ok.
 *
 * The status travels on the error so callers can tell a definitive "no such
 * thing" from a host that never answered. A missed beacon slot is a 404 on
 * every endpoint, and retrying it as if it were a transport fault reports a
 * normal gap in the chain as an outage.
 */
export class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

/**
 * A DNS lookup that timed out, as opposed to a name that does not exist.
 *
 * The production host's resolver stalls for five seconds now and then, about
 * one lookup in four hundred. Every endpoint of every chain fails together
 * while it does, so falling through to the next endpoint does not help — and a
 * vault that "did not answer" reads as a vault holding nothing. The resolver
 * answers again right after, so one more try is the fix.
 */
function isDnsStall(err: unknown): boolean {
  return (err as { cause?: { code?: string } })?.cause?.code === 'EAI_AGAIN';
}

/**
 * A URL as it may appear in an error.
 *
 * Paid endpoints carry their API key in the path (`/v2/<key>`), and these
 * messages reach logs and the public status endpoints. Long opaque path
 * segments are left out; a `0x` hash or a block number stays.
 */
export function shownUrl(url: string): string {
  const u = new URL(url);
  const path = u.pathname
    .split('/')
    .map((part) => (part.length >= 20 && !part.startsWith('0x') ? '…' : part))
    .join('/');
  return u.origin + (path === '/' ? '' : path);
}

/**
 * What went wrong, with the cause `fetch` keeps out of its message: on its own
 * it says `fetch failed` whether the name did not resolve, the connection was
 * refused or the peer hung up.
 */
function failure(url: string, err: unknown): Error {
  if (err instanceof HttpError) return err;
  const cause = (err as { cause?: { code?: string; message?: string } })?.cause;
  const why = cause ? cause.code ?? cause.message : undefined;
  return new Error(`${shownUrl(url)}: ${(err as Error).message}${why ? ` (${why})` : ''}`, { cause: err });
}

export type FetchJsonInit = { method?: string; headers?: Record<string, string>; body?: string };

/**
 * Origins whose port Node's `fetch` refuses outright.
 *
 * `fetch` implements the WHATWG bad-ports list, and an Antelope node does not
 * get to pick a different port because a browser specification dislikes it —
 * Wire serves its HTTP API on 6666, which is on that list as "ircu", and the
 * call fails with `bad port` before a packet is sent. Learned once per origin,
 * then taken directly.
 */
const rawOrigins = new Set<string>();

const isBadPort = (err: unknown): boolean =>
  (err as { cause?: { message?: string } })?.cause?.message === 'bad port';

/**
 * The same request through `node:http`, for an origin `fetch` will not touch.
 *
 * Content-Length is set explicitly because nodeop drops a chunked body
 * mid-request and then answers nothing at all, which reads as a hung node.
 */
function viaRaw(url: string, options: FetchJsonInit): Promise<any> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const body = options.body ?? '';
    const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = send(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        path: target.pathname + target.search,
        method: options.method ?? 'GET',
        headers: {
          ...options.headers,
          'content-length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let text = '';
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            return reject(new HttpError(status, `${shownUrl(url)} -> HTTP ${status}`));
          }
          try {
            resolve(JSON.parse(text));
          } catch (err) {
            reject(new Error(`${shownUrl(url)} answered ${status} with something that is not JSON`));
          }
        });
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

async function viaProxy(url: string, options: FetchJsonInit, proxy: string): Promise<any> {
  agent ??= new ProxyAgent(proxy);
  const res = await undiciFetch(url, { ...options, dispatcher: agent } as any);
  if (!res.ok) throw new HttpError(res.status, `${shownUrl(url)} via ${proxy} -> HTTP ${res.status}`);
  return await res.json();
}

async function direct(url: string, options: FetchJsonInit): Promise<any> {
  const res = await fetch(url, options);
  if (!res.ok) throw new HttpError(res.status, `${shownUrl(url)} -> HTTP ${res.status}`);
  return await res.json();
}

export async function fetchJson(url: string, init: FetchJsonInit = {}): Promise<any> {
  const options = { ...init, headers: { accept: 'application/json', ...init.headers } };
  const origin = new URL(url).origin;
  if (rawOrigins.has(origin)) return viaRaw(url, options);
  if (PROXY_ALL) return viaProxy(url, options, PROXY!);
  try {
    return await direct(url, options).catch((err) => {
      if (!isDnsStall(err)) throw err;
      return direct(url, options);
    });
  } catch (err) {
    if (isBadPort(err)) {
      rawOrigins.add(origin);
      return viaRaw(url, options);
    }
    if (!isStall(err) || !PROXY) throw failure(url, err);
    // A proxy that is not there must not hide why the direct request failed.
    return viaProxy(url, options, PROXY).catch((viaErr) => {
      throw new Error(`${failure(url, err).message}; via ${PROXY}: ${failure(url, viaErr).message}`, { cause: err });
    });
  }
}

/** JSON-RPC call on top of fetchJson; throws on the RPC-level error object. */
export async function jsonRpc(url: string, method: string, params: unknown[]): Promise<any> {
  const body = await fetchJson(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

/**
 * The same call against several endpoints, taking the first real answer.
 *
 * `null` counts as no answer, not as a fact: a pruned node reports a receipt it
 * no longer keeps as null rather than as an error, so asking only one node
 * turns retention policy into "your deposit does not exist". Errors are held
 * back and only raised if nothing answers.
 */
export async function jsonRpcAny(urls: string[], method: string, params: unknown[]): Promise<any> {
  let lastError: unknown = null;
  for (const url of urls) {
    try {
      const result = await jsonRpc(url, method, params);
      if (result !== null && result !== undefined) return result;
    } catch (err) {
      lastError = err;
    }
  }
  if (lastError) throw lastError;
  return null;
}
