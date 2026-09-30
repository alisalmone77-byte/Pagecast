import type { IncomingMessage, ServerResponse } from 'node:http';
import { config } from './config.js';
import type { PublicUser, Session } from './auth.js';

/** Minimal routing layer. Patterns use `:name` for a path segment. */
export interface RouteContext {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly params: Record<string, string>;
  readonly query: URLSearchParams;
  readonly url: URL;
  /**
   * The signed-in account. Guaranteed present on every route except the
   * handful registered as public, because the router rejects unauthenticated
   * requests before a handler ever runs -- a route cannot forget to check.
   */
  readonly user: PublicUser;
  readonly session: Session | null;
  /** Convenience alias: the owner id everything is scoped by. */
  readonly userId: string;
  /** Identifies the device, so a client can ignore the echo of its own write. */
  readonly deviceId: string;
}

export type Handler = (ctx: RouteContext) => Promise<void> | void;

/** Resolves a request to an account, or null when it is not signed in. */
export type Authenticator = (
  req: IncomingMessage,
  res: ServerResponse,
) => Promise<{ user: PublicUser; session: Session } | null>;

interface Route {
  method: string;
  segments: string[];
  handler: Handler;
  /** Public routes run without a session: sign-in, sign-up, health. */
  isPublic: boolean;
}

export class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly detail?: unknown) {
    super(message);
    this.name = 'HttpError';
  }
}

export class Router {
  private readonly routes: Route[] = [];
  private authenticate: Authenticator = async () => null;

  /** Supplied by the server once the store is up. */
  setAuthenticator(authenticator: Authenticator): this {
    this.authenticate = authenticator;
    return this;
  }

  add(method: string, pattern: string, handler: Handler, isPublic = false): this {
    this.routes.push({ method, segments: pattern.split('/').filter(Boolean), handler, isPublic });
    return this;
  }

  get(pattern: string, handler: Handler) { return this.add('GET', pattern, handler); }
  post(pattern: string, handler: Handler) { return this.add('POST', pattern, handler); }
  put(pattern: string, handler: Handler) { return this.add('PUT', pattern, handler); }
  patch(pattern: string, handler: Handler) { return this.add('PATCH', pattern, handler); }
  delete(pattern: string, handler: Handler) { return this.add('DELETE', pattern, handler); }

  /** Register a route that does not require a session. */
  public_(method: string, pattern: string, handler: Handler) {
    return this.add(method, pattern, handler, true);
  }

  /** Returns false when nothing matched, so the caller can fall through to static files. */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);

    let methodMismatch = false;
    for (const route of this.routes) {
      const params = match(route.segments, parts);
      if (params === null) continue;
      if (route.method !== req.method) { methodMismatch = true; continue; }

      // Authentication happens here, once, rather than in each handler: a
      // route added later cannot forget to check, because it never receives a
      // context without a user.
      const authed = await this.authenticate(req, res);
      if (!authed && !route.isPublic) {
        throw new HttpError(401, 'sign in to continue');
      }

      const ctx: RouteContext = {
        req, res, params, url,
        query: url.searchParams,
        user: authed?.user ?? ANONYMOUS,
        session: authed?.session ?? null,
        userId: authed?.user.id ?? ANONYMOUS.id,
        deviceId: headerOr(req, 'x-pagecast-device', 'unknown'),
      };
      await route.handler(ctx);
      return true;
    }
    if (methodMismatch) throw new HttpError(405, `method ${req.method} not allowed for ${url.pathname}`);
    return false;
  }
}

/**
 * Stand-in user for public routes. Its id is not a valid account id, so if a
 * public handler ever scoped a query by it the result would be empty rather
 * than someone else's library.
 */
const ANONYMOUS: PublicUser = {
  id: '\u0000anonymous',
  email: '',
  displayName: 'Anonymous',
  createdAt: new Date(0).toISOString(),
};

function match(pattern: string[], parts: string[]): Record<string, string> | null {
  // A trailing `*` captures the remainder of the path.
  const wildcard = pattern[pattern.length - 1] === '*';
  if (!wildcard && pattern.length !== parts.length) return null;
  if (wildcard && parts.length < pattern.length - 1) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i += 1) {
    const seg = pattern[i]!;
    if (seg === '*') {
      params['rest'] = parts.slice(i).join('/');
      return params;
    }
    const part = parts[i];
    if (part === undefined) return null;
    if (seg.startsWith(':')) params[seg.slice(1)] = part;
    else if (seg !== part) return null;
  }
  return params;
}

function headerOr(req: IncomingMessage, name: string, fallback: string): string {
  const raw = req.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value && value.trim().length > 0 ? value.trim() : fallback;
}

/* ------------------------------------------------------------- responses */

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

export function sendError(res: ServerResponse, err: unknown): void {
  if (err instanceof HttpError) {
    sendJson(res, err.status, { error: err.message, detail: err.detail ?? null });
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  console.error('[api] unhandled error:', err);
  sendJson(res, 500, { error: 'internal error', detail: message });
}

/* ------------------------------------------------------------ request body */

/** Read the whole request body, refusing anything over the configured limit. */
export async function readBody(req: IncomingMessage, limit = config.maxUploadBytes): Promise<Buffer> {
  const declared = Number(req.headers['content-length'] ?? '0');
  if (Number.isFinite(declared) && declared > limit) {
    throw new HttpError(413, `body of ${declared} bytes exceeds the ${limit} byte limit`);
  }

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > limit) throw new HttpError(413, `body exceeds the ${limit} byte limit`);
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

export async function readJson<T>(req: IncomingMessage): Promise<T> {
  const raw = await readBody(req);
  if (raw.length === 0) throw new HttpError(400, 'expected a JSON body');
  try {
    return JSON.parse(raw.toString('utf8')) as T;
  } catch {
    throw new HttpError(400, 'body is not valid JSON');
  }
}

/**
 * CORS for the Vite dev server and the iOS simulator.
 *
 * Credentials are allowed, so the origin is echoed rather than sent as `*` --
 * a wildcard is invalid with credentials and browsers reject it. That echo is
 * only safe because the session cookie is SameSite=Lax: a cross-site page can
 * ask for a response, but the browser will not attach the cookie to the
 * request, so it gets an unauthenticated one.
 */
export function applyCors(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('access-control-allow-credentials', 'true');
  } else {
    res.setHeader('access-control-allow-origin', '*');
  }
  res.setHeader('vary', 'origin');
  res.setHeader('access-control-allow-methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader(
    'access-control-allow-headers',
    'content-type,authorization,x-pagecast-device,x-pagecast-filename,x-pagecast-title',
  );
  res.setHeader('access-control-max-age', '86400');
}
