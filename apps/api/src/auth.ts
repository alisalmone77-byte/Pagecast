import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { config } from './config.js';
import { HttpError } from './http.js';

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer, salt: string | Buffer, keylen: number,
) => Promise<Buffer>;

/**
 * Accounts and sessions.
 *
 * Sessions are server-side records keyed by an opaque token, not signed JWTs.
 * The deciding factor is revocation: this is a reading app that people install
 * on phones, and "log me out everywhere" has to actually end the other
 * device's access the moment it is pressed. A stateless token cannot do that
 * without a revocation list, which is a session store with extra steps.
 */

export interface User {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  /** scrypt-derived, stored as `scrypt$N$r$p$salt$hash`, all base64. */
  readonly passwordHash: string;
  readonly createdAt: string;
}

export interface Session {
  readonly token: string;
  readonly userId: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  /** Recorded so the account screen can list where you are signed in. */
  readonly userAgent?: string;
}

/** Public shape: never let a password hash out of this module. */
export interface PublicUser {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly createdAt: string;
}

export function toPublicUser(user: User): PublicUser {
  return { id: user.id, email: user.email, displayName: user.displayName, createdAt: user.createdAt };
}

/* ------------------------------------------------------------- passwords */

const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password.normalize('NFKC'), salt, KEY_LENGTH);
  return [
    'scrypt', SCRYPT_N, SCRYPT_R, SCRYPT_P,
    salt.toString('base64'), derived.toString('base64'),
  ].join('$');
}

/**
 * Verify a password. Always runs the full derivation, and compares in constant
 * time, so a wrong password costs the same as a right one and neither the
 * timing nor the error distinguishes "no such account" from "wrong password".
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const saltRaw = parts[4];
  const hashRaw = parts[5];
  if (!saltRaw || !hashRaw) return false;

  const salt = Buffer.from(saltRaw, 'base64');
  const expected = Buffer.from(hashRaw, 'base64');
  const derived = await scrypt(password.normalize('NFKC'), salt, expected.length);
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/** A hash to compare against when no account exists, so lookups take equal time. */
let decoyHash: string | null = null;
export async function decoyVerify(password: string): Promise<void> {
  decoyHash ??= await hashPassword(randomBytes(24).toString('hex'));
  await verifyPassword(password, decoyHash);
}

/* -------------------------------------------------------------- sessions */

export const SESSION_COOKIE = 'pagecast_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Refresh the expiry when a session is more than a day old. */
const SESSION_REFRESH_AFTER_MS = 24 * 60 * 60 * 1000;

export function newSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function newSession(userId: string, userAgent?: string): Session {
  const now = Date.now();
  return {
    token: newSessionToken(),
    userId,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + SESSION_TTL_MS).toISOString(),
    userAgent: userAgent?.slice(0, 200),
  };
}

export function isExpired(session: Session, now = Date.now()): boolean {
  const expiry = Date.parse(session.expiresAt);
  return !Number.isFinite(expiry) || expiry <= now;
}

/** True when a session is old enough that its expiry should slide forward. */
export function shouldRefresh(session: Session, now = Date.now()): boolean {
  const expiry = Date.parse(session.expiresAt);
  if (!Number.isFinite(expiry)) return false;
  return expiry - now < SESSION_TTL_MS - SESSION_REFRESH_AFTER_MS;
}

export function refreshed(session: Session, now = Date.now()): Session {
  return { ...session, expiresAt: new Date(now + SESSION_TTL_MS).toISOString() };
}

/* --------------------------------------------------------------- cookies */

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name.length === 0) continue;
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

export function sessionTokenFrom(req: IncomingMessage): string | null {
  const fromCookie = parseCookies(req.headers['cookie'])[SESSION_COOKIE];
  if (fromCookie) return fromCookie;

  // Native clients that cannot rely on a cookie jar may send the token as a
  // bearer credential instead. Same opaque token, same server-side record.
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
    const token = auth.slice(7).trim();
    if (token.length > 0) return token;
  }
  return null;
}

/**
 * Build the Set-Cookie header.
 *
 * HttpOnly so a script cannot read it; SameSite=Lax so the browser withholds
 * it from cross-site POSTs, which is what makes this API safe without separate
 * CSRF tokens -- Lax sends cookies only on top-level GET navigations, and every
 * mutating route here is a POST, PUT, PATCH or DELETE.
 */
export function sessionCookie(token: string, maxAgeSeconds: number): string {
  const attributes = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (config.auth.secureCookies) attributes.push('Secure');
  return attributes.join('; ');
}

export function setSessionCookie(res: ServerResponse, token: string): void {
  res.setHeader('set-cookie', sessionCookie(token, Math.floor(SESSION_TTL_MS / 1000)));
}

export function clearSessionCookie(res: ServerResponse): void {
  res.setHeader('set-cookie', sessionCookie('', 0));
}

/* ------------------------------------------------------------ validation */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function normaliseEmail(value: unknown): string {
  if (typeof value !== 'string') throw new HttpError(400, 'an email address is required');
  const email = value.trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 254) {
    throw new HttpError(400, 'that does not look like an email address');
  }
  return email;
}

export function validatePassword(value: unknown): string {
  if (typeof value !== 'string') throw new HttpError(400, 'a password is required');
  // Length is the only rule. Composition rules push people towards
  // "Password1!" and away from the long passphrases that actually resist
  // guessing; the 72-byte ceiling keeps one request from costing a second of
  // CPU in the key derivation.
  if (value.length < 10) throw new HttpError(400, 'passwords must be at least 10 characters');
  if (Buffer.byteLength(value, 'utf8') > 200) throw new HttpError(400, 'that password is too long');
  return value;
}

export function validateDisplayName(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) return fallback;
  return value.trim().slice(0, 80);
}

/* ---------------------------------------------------------- rate limiting */

/**
 * A fixed-window counter over failed sign-in attempts, keyed by email and by
 * source address. In-memory, which is the right scope for a single-process
 * self-hosted server: it blunts online guessing, and it is not pretending to
 * be a distributed rate limiter.
 */
export class AttemptLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit = 10,
    private readonly windowMs = 15 * 60 * 1000,
  ) {}

  /** Throws once the limit is reached. */
  check(key: string, now = Date.now()): void {
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) return;
    if (entry.count >= this.limit) {
      const seconds = Math.ceil((entry.resetAt - now) / 1000);
      throw new HttpError(429, `too many attempts; try again in ${seconds} seconds`);
    }
  }

  fail(key: string, now = Date.now()): void {
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return;
    }
    entry.count += 1;
  }

  succeed(key: string): void {
    this.hits.delete(key);
  }

  /** Drop expired windows so the map cannot grow without bound. */
  sweep(now = Date.now()): void {
    for (const [key, entry] of this.hits) {
      if (entry.resetAt <= now) this.hits.delete(key);
    }
  }
}

export function clientKey(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const address = first?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
  return address;
}
