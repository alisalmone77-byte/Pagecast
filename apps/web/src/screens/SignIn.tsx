import { useEffect, useState } from 'react';
import { api, type AuthConfig, type PublicUser } from '../api/client.js';

/**
 * Sign-in and sign-up.
 *
 * One screen for both, because on a self-hosted install the first visit is
 * always a sign-up and every visit after that is a sign-in; asking people to
 * find the right tab is friction with nothing behind it. The server tells us
 * which case we are in.
 */
export function SignIn({ onSignedIn }: { onSignedIn: (user: PublicUser) => void }) {
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const [mode, setMode] = useState<'signin' | 'register'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.authConfig()
      .then((next) => {
        setConfig(next);
        // A server with no accounts yet can only be signed up to.
        if (!next.hasAccounts && next.allowRegistration) setMode('register');
      })
      .catch(() => setConfig({ allowRegistration: true, requiresInvite: false, hasAccounts: true }));
  }, []);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const user = mode === 'register'
        ? await api.register({
            email: email.trim(),
            password,
            displayName: displayName.trim() || undefined,
            inviteCode: inviteCode.trim() || undefined,
          })
        : await api.login({ email: email.trim(), password });
      onSignedIn(user);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const firstRun = config !== null && !config.hasAccounts;
  const registering = mode === 'register';

  return (
    <div className="signin">
      <form className="signin__card" onSubmit={submit}>
        <div className="signin__brand" aria-hidden="true">
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H10a2 2 0 0 1 2 2v12a2 2 0 0 0-2-2H5.5A1.5 1.5 0 0 1 4 14.5Z" />
            <path d="M20 5.5A1.5 1.5 0 0 0 18.5 4H14a2 2 0 0 0-2 2v12a2 2 0 0 1 2-2h4.5a1.5 1.5 0 0 0 1.5-1.5Z" />
          </svg>
          <span>Pagecast</span>
        </div>

        <h1 className="signin__title">
          {firstRun ? 'Create the first account' : registering ? 'Create an account' : 'Sign in'}
        </h1>
        <p className="signin__subtitle">
          {firstRun
            ? 'This server has no accounts yet. The one you create now takes ownership of anything already in the library.'
            : 'Your library, your progress, and where you left off on every device.'}
        </p>

        {registering && (
          <label className="field">
            <span>Name</span>
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Optional"
              autoComplete="name"
            />
          </label>
        )}

        <label className="field">
          <span>Email</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoFocus
            autoComplete="username"
          />
        </label>

        <label className="field">
          <span>Password</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={registering ? 10 : undefined}
            autoComplete={registering ? 'new-password' : 'current-password'}
          />
          {registering && (
            <small className="field__hint">
              At least 10 characters. A few ordinary words you will remember beats
              a short one you will not.
            </small>
          )}
        </label>

        {registering && config?.requiresInvite && (
          <label className="field">
            <span>Invitation code</span>
            <input value={inviteCode} onChange={(e) => setInviteCode(e.target.value)} required />
          </label>
        )}

        {error && <p className="signin__error" role="alert">{error}</p>}

        <button type="submit" className="btn btn--primary btn--block" disabled={busy}>
          {busy ? 'Just a moment…' : registering ? 'Create account' : 'Sign in'}
        </button>

        {!firstRun && config?.allowRegistration && (
          <button
            type="button"
            className="btn btn--ghost btn--block"
            onClick={() => { setMode(registering ? 'signin' : 'register'); setError(null); }}
          >
            {registering ? 'I already have an account' : 'Create an account instead'}
          </button>
        )}
        {!registering && config && !config.allowRegistration && (
          <p className="signin__note">Registration is closed on this server.</p>
        )}
      </form>
    </div>
  );
}
