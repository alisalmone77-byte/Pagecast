import { randomUUID } from 'node:crypto';
import {
  AttemptLimiter, clearSessionCookie, clientKey, decoyVerify, hashPassword,
  newSession, normaliseEmail, sessionTokenFrom, setSessionCookie, toPublicUser,
  validateDisplayName, validatePassword, verifyPassword, type User,
} from '../auth.js';
import { config } from '../config.js';
import { HttpError, readJson, sendJson, type Router } from '../http.js';
import { store } from '../store.js';

/** Sign-up, sign-in, sign-out and the current account. */

/**
 * Two limiters with different budgets, because they defend against different
 * things and a single budget cannot serve both.
 *
 * The per-account limit is tight: ten wrong guesses at one address is already
 * far past honest mistyping, and locking that one account out costs its owner
 * a short wait.
 *
 * The per-address limit has to be much looser. A household, an office or a
 * school behind one NAT all share a source address, and a limit tuned for a
 * single person would lock the whole building out because one of them forgot
 * their password. It exists to blunt spraying one password across many
 * accounts, which the per-account limiter cannot see.
 */
const accountLimiter = new AttemptLimiter(10, 15 * 60 * 1000);
const addressLimiter = new AttemptLimiter(50, 15 * 60 * 1000);

// Keep the window maps from growing without bound on a long-lived server.
setInterval(() => {
  accountLimiter.sweep();
  addressLimiter.sweep();
}, 10 * 60 * 1000).unref();

export function registerAuthRoutes(router: Router): void {
  /**
   * What the client needs before anyone has signed in: whether registration is
   * open, and whether this is a brand-new server with no accounts yet, so the
   * UI can show "create the first account" rather than a sign-in form.
   */
  router.public_('GET', '/api/auth/config', (ctx) => {
    sendJson(ctx.res, 200, {
      allowRegistration: config.auth.allowRegistration,
      requiresInvite: config.auth.invitationCode.length > 0,
      hasAccounts: store.userCount > 0,
    });
  });

  router.public_('POST', '/api/auth/register', async (ctx) => {
    if (!config.auth.allowRegistration) {
      throw new HttpError(403, 'registration is closed on this server');
    }

    const body = await readJson<{
      email?: unknown; password?: unknown; displayName?: unknown; inviteCode?: unknown;
    }>(ctx.req);

    if (config.auth.invitationCode.length > 0) {
      const supplied = typeof body.inviteCode === 'string' ? body.inviteCode : '';
      if (supplied !== config.auth.invitationCode) {
        throw new HttpError(403, 'that invitation code is not valid');
      }
    }

    // Rate-limit registration too: it is the one unauthenticated endpoint that
    // does real work, and scrypt is expensive by design.
    const key = `register:${clientKey(ctx.req)}`;
    addressLimiter.check(key);

    const email = normaliseEmail(body.email);
    const password = validatePassword(body.password);

    if (store.findUserByEmail(email)) {
      addressLimiter.fail(key);
      throw new HttpError(409, 'an account already exists for that email address');
    }

    const user: User = {
      id: randomUUID(),
      email,
      displayName: validateDisplayName(body.displayName, email.split('@')[0] ?? 'Reader'),
      passwordHash: await hashPassword(password),
      createdAt: new Date().toISOString(),
    };
    await store.createUser(user);

    const session = await store.createSession(
      newSession(user.id, headerString(ctx.req.headers['user-agent'])),
    );
    setSessionCookie(ctx.res, session.token);
    addressLimiter.succeed(key);

    // The token is returned as well as set as a cookie, for native clients
    // that would rather carry it as a bearer credential.
    sendJson(ctx.res, 201, { user: toPublicUser(user), token: session.token });
  });

  router.public_('POST', '/api/auth/login', async (ctx) => {
    const body = await readJson<{ email?: unknown; password?: unknown }>(ctx.req);
    const email = normaliseEmail(body.email);
    const password = typeof body.password === 'string' ? body.password : '';

    // Limited by address and by account, so neither spraying one password
    // across many accounts nor hammering one account gets far.
    const addressKey = `login:${clientKey(ctx.req)}`;
    const accountKey = `login:${email}`;
    addressLimiter.check(addressKey);
    accountLimiter.check(accountKey);

    const user = store.findUserByEmail(email);
    if (!user) {
      // Burn the same work a real verification costs, so response time does
      // not reveal whether the account exists.
      await decoyVerify(password);
      addressLimiter.fail(addressKey);
      accountLimiter.fail(accountKey);
      throw new HttpError(401, 'that email address and password do not match');
    }

    if (!(await verifyPassword(password, user.passwordHash))) {
      addressLimiter.fail(addressKey);
      accountLimiter.fail(accountKey);
      throw new HttpError(401, 'that email address and password do not match');
    }

    addressLimiter.succeed(addressKey);
    accountLimiter.succeed(accountKey);

    const session = await store.createSession(
      newSession(user.id, headerString(ctx.req.headers['user-agent'])),
    );
    setSessionCookie(ctx.res, session.token);
    sendJson(ctx.res, 200, { user: toPublicUser(user), token: session.token });
  });

  /** Public so signing out is idempotent even once the session has expired. */
  router.public_('POST', '/api/auth/logout', async (ctx) => {
    const token = sessionTokenFrom(ctx.req);
    if (token) await store.deleteSession(token);
    clearSessionCookie(ctx.res);
    sendJson(ctx.res, 200, { ok: true });
  });

  router.get('/api/auth/me', (ctx) => {
    sendJson(ctx.res, 200, {
      user: ctx.user,
      sessions: store.listSessionsForUser(ctx.userId).map((session) => ({
        current: session.token === ctx.session?.token,
        createdAt: session.createdAt,
        expiresAt: session.expiresAt,
        userAgent: session.userAgent ?? null,
      })),
    });
  });

  /** Sign out everywhere: the reason sessions are server-side records. */
  router.post('/api/auth/logout-all', async (ctx) => {
    const removed = await store.deleteSessionsForUser(ctx.userId);
    clearSessionCookie(ctx.res);
    sendJson(ctx.res, 200, { ok: true, endedSessions: removed });
  });

  router.post('/api/auth/password', async (ctx) => {
    const body = await readJson<{ currentPassword?: unknown; newPassword?: unknown }>(ctx.req);
    const user = store.getUser(ctx.userId);
    if (!user) throw new HttpError(401, 'sign in to continue');

    const current = typeof body.currentPassword === 'string' ? body.currentPassword : '';
    if (!(await verifyPassword(current, user.passwordHash))) {
      throw new HttpError(403, 'that is not your current password');
    }
    const next = validatePassword(body.newPassword);

    await store.updateUser({ ...user, passwordHash: await hashPassword(next) });

    // Changing a password ends every other session: that is what someone
    // reaching for this control is usually trying to achieve.
    await store.deleteSessionsForUser(user.id);
    const session = await store.createSession(
      newSession(user.id, headerString(ctx.req.headers['user-agent'])),
    );
    setSessionCookie(ctx.res, session.token);
    sendJson(ctx.res, 200, { ok: true, token: session.token });
  });
}

function headerString(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw && raw.length > 0 ? raw : undefined;
}
