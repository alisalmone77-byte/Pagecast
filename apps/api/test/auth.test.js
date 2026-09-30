import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pagecast-auth-'));
process.env.PAGECAST_DATA_DIR = dataDir;
process.env.PAGECAST_TTS_PROVIDER = 'local';

const { createServer } = await import('../dist/server.js');
const { store } = await import('../dist/store.js');
const { startServer } = await import('./helpers.js');
const {
  AttemptLimiter, hashPassword, verifyPassword, parseCookies, sessionCookie,
  isExpired, shouldRefresh, newSession,
} = await import('../dist/auth.js');

let base;
let stop;

before(async () => {
  await store.init();
  ({ base, stop } = await startServer(createServer));
});

after(async () => {
  await stop?.();
  await fs.rm(dataDir, { recursive: true, force: true });
});

async function call(method, route, body, headers = {}) {
  const init = { method, headers: { ...headers } };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers['content-type'] = 'application/json';
  }
  const res = await fetch(`${base}${route}`, init);
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  return { status: res.status, json, headers: res.headers };
}

/* ------------------------------------------------------------- unit tests */

test('a password verifies against its own hash and nothing else', async () => {
  const hash = await hashPassword('correct horse battery staple');
  assert.ok(await verifyPassword('correct horse battery staple', hash));
  assert.equal(await verifyPassword('Correct horse battery staple', hash), false);
  assert.equal(await verifyPassword('', hash), false);
});

test('hashing the same password twice gives different hashes', async () => {
  const a = await hashPassword('the same passphrase');
  const b = await hashPassword('the same passphrase');
  assert.notEqual(a, b, 'each hash must carry its own salt');
  assert.ok(await verifyPassword('the same passphrase', a));
  assert.ok(await verifyPassword('the same passphrase', b));
});

test('a malformed stored hash fails closed', async () => {
  for (const bad of ['', 'nonsense', 'scrypt$1$2$3', 'bcrypt$1$2$3$4$5']) {
    assert.equal(await verifyPassword('anything', bad), false, `"${bad}" should not verify`);
  }
});

test('unicode passwords normalise so the same keystrokes always match', async () => {
  // U+00E9 and "e" + U+0301 render identically; a reader typing on a different
  // keyboard must not be locked out by the encoding.
  const composed = 'café passphrase';
  const decomposed = 'café passphrase';
  assert.ok(await verifyPassword(decomposed, await hashPassword(composed)));
});

test('cookies parse, including values with padding and equals signs', () => {
  const parsed = parseCookies('a=1; pagecast_session=abc%3D%3D;  b=2');
  assert.equal(parsed.a, '1');
  assert.equal(parsed.pagecast_session, 'abc==');
  assert.equal(parsed.b, '2');
  assert.deepEqual(parseCookies(undefined), {});
  assert.deepEqual(parseCookies(''), {});
});

test('the session cookie is HttpOnly and SameSite=Lax', () => {
  const cookie = sessionCookie('token123', 3600);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Max-Age=3600/);
  assert.match(cookie, /Path=\//);
});

test('session expiry and refresh windows behave', () => {
  const session = newSession('user1');
  assert.equal(isExpired(session), false);
  assert.equal(shouldRefresh(session), false, 'a fresh session does not need refreshing');

  const old = { ...session, expiresAt: new Date(Date.now() - 1000).toISOString() };
  assert.equal(isExpired(old), true);
  assert.equal(isExpired({ ...session, expiresAt: 'not a date' }), true, 'a bad date must fail closed');

  const aging = { ...session, expiresAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString() };
  assert.equal(shouldRefresh(aging), true);
});

test('the attempt limiter opens, trips and resets', () => {
  const limiter = new AttemptLimiter(3, 1000);
  limiter.check('k');
  for (let i = 0; i < 3; i += 1) limiter.fail('k');
  assert.throws(() => limiter.check('k'), /too many attempts/);

  // A success clears the window immediately.
  limiter.succeed('k');
  limiter.check('k');

  for (let i = 0; i < 3; i += 1) limiter.fail('k', 0);
  assert.throws(() => limiter.check('k', 0), /too many attempts/);
  limiter.check('k', 2000);
});

test('the limiter sweeps expired windows', () => {
  const limiter = new AttemptLimiter(1, 100);
  limiter.fail('gone', 0);
  limiter.sweep(10_000);
  limiter.check('gone', 10_000);
});

/* ------------------------------------------------------- endpoint tests */

test('a fresh server reports that it has no accounts yet', async () => {
  const res = await call('GET', '/api/auth/config');
  assert.equal(res.status, 200);
  assert.equal(res.json.allowRegistration, true);
  assert.equal(res.json.hasAccounts, false);
});

test('registering signs you in and sets a cookie', async () => {
  const res = await call('POST', '/api/auth/register', {
    email: 'First@Example.com ', password: 'a decent long passphrase', displayName: 'First',
  });
  assert.equal(res.status, 201);
  assert.equal(res.json.user.email, 'first@example.com', 'email should be normalised');
  assert.equal(res.json.user.displayName, 'First');
  assert.ok(res.json.token);
  assert.match(res.headers.get('set-cookie') ?? '', /pagecast_session=/);
  assert.equal('passwordHash' in res.json.user, false, 'never return the hash');
});

test('config now reports that accounts exist', async () => {
  assert.equal((await call('GET', '/api/auth/config')).json.hasAccounts, true);
});

test('weak and malformed credentials are refused', async () => {
  assert.equal((await call('POST', '/api/auth/register', { email: 'x@y.co', password: 'short' })).status, 400);
  assert.equal((await call('POST', '/api/auth/register', { email: 'not-an-email', password: 'long enough here' })).status, 400);
  assert.equal((await call('POST', '/api/auth/register', { password: 'long enough here' })).status, 400);
  assert.equal((await call('POST', '/api/auth/register', { email: 'x@y.co' })).status, 400);
});

test('an email address can only be registered once', async () => {
  const body = { email: 'dup@example.com', password: 'a decent long passphrase' };
  assert.equal((await call('POST', '/api/auth/register', body)).status, 201);
  assert.equal((await call('POST', '/api/auth/register', body)).status, 409);
});

test('signing in returns a working token', async () => {
  const res = await call('POST', '/api/auth/login', {
    email: 'first@example.com', password: 'a decent long passphrase',
  });
  assert.equal(res.status, 200);

  const me = await call('GET', '/api/auth/me', undefined, { authorization: `Bearer ${res.json.token}` });
  assert.equal(me.status, 200);
  assert.equal(me.json.user.email, 'first@example.com');
  assert.ok(me.json.sessions.some((s) => s.current));
});

test('a wrong password and an unknown account give the same answer', async () => {
  const wrong = await call('POST', '/api/auth/login', {
    email: 'first@example.com', password: 'not the passphrase',
  });
  const missing = await call('POST', '/api/auth/login', {
    email: 'nobody@example.com', password: 'not the passphrase',
  });
  assert.equal(wrong.status, 401);
  assert.equal(missing.status, 401);
  assert.equal(wrong.json.error, missing.json.error,
    'the error must not reveal whether the account exists');
});

test('protected routes refuse anonymous callers', async () => {
  for (const [method, route] of [
    ['GET', '/api/documents'],
    ['GET', '/api/documents/continue'],
    ['GET', '/api/folders'],
    ['GET', '/api/voices'],
    ['GET', '/api/auth/me'],
    ['POST', '/api/ingest/url'],
    ['GET', '/api/sync/state'],
  ]) {
    const res = await call(method, route);
    assert.equal(res.status, 401, `${method} ${route} should require a session`);
  }
});

test('a garbage or expired token is rejected, not accepted', async () => {
  for (const bad of ['nonsense', '', 'Bearer', 'a'.repeat(64)]) {
    const res = await call('GET', '/api/documents', undefined, { authorization: `Bearer ${bad}` });
    assert.equal(res.status, 401);
  }
});

test('health stays public so a probe needs no credentials', async () => {
  const res = await call('GET', '/api/health');
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal('documents' in res.json, false, 'health must not report library size');
});

test('signing out invalidates the token', async () => {
  const login = await call('POST', '/api/auth/login', {
    email: 'first@example.com', password: 'a decent long passphrase',
  });
  const auth = { authorization: `Bearer ${login.json.token}` };
  assert.equal((await call('GET', '/api/auth/me', undefined, auth)).status, 200);

  const out = await call('POST', '/api/auth/logout', undefined, auth);
  assert.equal(out.status, 200);
  assert.match(out.headers.get('set-cookie') ?? '', /Max-Age=0/);
  assert.equal((await call('GET', '/api/auth/me', undefined, auth)).status, 401);
});

test('signing out is idempotent without a session', async () => {
  assert.equal((await call('POST', '/api/auth/logout')).status, 200);
});

test('sign out everywhere ends every session for that account', async () => {
  const credentials = { email: 'multi@example.com', password: 'a decent long passphrase' };
  await call('POST', '/api/auth/register', credentials);

  const a = (await call('POST', '/api/auth/login', credentials)).json.token;
  const b = (await call('POST', '/api/auth/login', credentials)).json.token;
  assert.notEqual(a, b);

  const res = await call('POST', '/api/auth/logout-all', undefined, { authorization: `Bearer ${a}` });
  assert.equal(res.status, 200);
  assert.ok(res.json.endedSessions >= 2);

  for (const token of [a, b]) {
    assert.equal((await call('GET', '/api/auth/me', undefined, { authorization: `Bearer ${token}` })).status, 401);
  }
});

test('changing a password requires the current one and ends other sessions', async () => {
  const credentials = { email: 'rotate@example.com', password: 'the original passphrase' };
  await call('POST', '/api/auth/register', credentials);
  const first = (await call('POST', '/api/auth/login', credentials)).json.token;
  const second = (await call('POST', '/api/auth/login', credentials)).json.token;

  const wrong = await call('POST', '/api/auth/password',
    { currentPassword: 'wrong', newPassword: 'a brand new passphrase' },
    { authorization: `Bearer ${first}` });
  assert.equal(wrong.status, 403);

  const ok = await call('POST', '/api/auth/password',
    { currentPassword: 'the original passphrase', newPassword: 'a brand new passphrase' },
    { authorization: `Bearer ${first}` });
  assert.equal(ok.status, 200);

  // The other device is signed out; the old password no longer works.
  assert.equal((await call('GET', '/api/auth/me', undefined, { authorization: `Bearer ${second}` })).status, 401);
  assert.equal((await call('POST', '/api/auth/login', credentials)).status, 401);
  assert.equal((await call('POST', '/api/auth/login',
    { email: 'rotate@example.com', password: 'a brand new passphrase' })).status, 200);
  // The session returned by the change still works.
  assert.equal((await call('GET', '/api/auth/me', undefined,
    { authorization: `Bearer ${ok.json.token}` })).status, 200);
});

test('a short new password is refused before anything changes', async () => {
  const credentials = { email: 'keep@example.com', password: 'the original passphrase' };
  await call('POST', '/api/auth/register', credentials);
  const token = (await call('POST', '/api/auth/login', credentials)).json.token;

  const res = await call('POST', '/api/auth/password',
    { currentPassword: 'the original passphrase', newPassword: 'short' },
    { authorization: `Bearer ${token}` });
  assert.equal(res.status, 400);
  assert.equal((await call('POST', '/api/auth/login', credentials)).status, 200,
    'the original password must still work');
});

test('repeated failures against one account are rate limited', async () => {
  const email = 'target@example.com';
  await call('POST', '/api/auth/register', { email, password: 'a decent long passphrase' });

  let sawLimit = false;
  for (let i = 0; i < 14; i += 1) {
    const res = await call('POST', '/api/auth/login', { email, password: `guess-${i}` });
    if (res.status === 429) { sawLimit = true; break; }
  }
  assert.ok(sawLimit, 'brute-force attempts should eventually be refused');

  // Locking that account must not lock out everyone else sharing the address:
  // a household, office or school behind one NAT all look like one client.
  const other = { email: 'bystander@example.com', password: 'a decent long passphrase' };
  await call('POST', '/api/auth/register', other);
  assert.equal((await call('POST', '/api/auth/login', other)).status, 200,
    'a different account from the same address must still be able to sign in');
});

test('CORS allows credentials and echoes the origin rather than sending a wildcard', async () => {
  const res = await fetch(`${base}/api/documents`, {
    method: 'OPTIONS',
    headers: { origin: 'http://localhost:5173' },
  });
  assert.equal(res.headers.get('access-control-allow-origin'), 'http://localhost:5173');
  assert.equal(res.headers.get('access-control-allow-credentials'), 'true');
});

test('a session cookie authenticates just like a bearer token', async () => {
  const login = await call('POST', '/api/auth/login', {
    email: 'first@example.com', password: 'a decent long passphrase',
  });
  const raw = login.headers.get('set-cookie') ?? '';
  const cookie = raw.split(';')[0];

  const res = await call('GET', '/api/auth/me', undefined, { cookie });
  assert.equal(res.status, 200);
  assert.equal(res.json.user.email, 'first@example.com');
});
