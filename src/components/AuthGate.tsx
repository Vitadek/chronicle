import { useEffect, useState } from 'react';
import { KeyRound } from 'lucide-react';
import { authService, type AuthConfig, type AuthUser } from '../services/authService';

/**
 * Gates the app on authentication. The data services already attach the stored
 * bearer via authFetch; this supplies the missing half — actually obtaining a
 * token in interactive modes.
 *
 * On load it reads /api/auth/config:
 *   - none / forward : no token needed, render immediately.
 *   - token          : verify the stored token against /api/auth/me; if the
 *                      server rejects it (or there is none), show the access-
 *                      token prompt instead of a half-broken app. If the server
 *                      is UNREACHABLE we still render — offline recovery UI
 *                      must stay accessible, and `me()` distinguishes the two
 *                      (null = rejected, throw = unreachable).
 *   - oidc           : if there's no stored token, redirect into
 *                      /api/auth/oidc/start; the callback stores the token and
 *                      bounces back here. A stored-but-expired token is caught by
 *                      the global 'chronicle:auth-required' (401) handler, which
 *                      clears it and re-logs-in — guarded against redirect loops.
 */
export function AuthGate({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsToken, setNeedsToken] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let onAuthRequired: (() => void) | null = null;
    // Never carry a previously verified collaboration scope into a new auth
    // bootstrap attempt (including an account switch in the same tab).
    authService.clearUserId();

    (async () => {
      let config: AuthConfig;
      try {
        config = await authService.getConfig();
      } catch {
        // Server unreachable / no auth config — let the app render and surface
        // its own connection errors rather than blocking on a blank screen.
        if (!cancelled) setReady(true);
        return;
      }

      // On a 401 mid-session: OIDC restarts login (loop-guarded); token mode
      // re-opens the prompt (the token was rotated or revoked server-side).
      onAuthRequired = () => {
        if (config.mode === 'token') {
          authService.clear();
          setReady(false);
          setNeedsToken(true);
          return;
        }
        if (config.mode !== 'oidc') return;
        const now = Date.now();
        const last = Number(sessionStorage.getItem('chronicle_oidc_redirect_at') || 0);
        if (now - last < 10_000) {
          setError('Sign-in did not complete. Please reload to try again.');
          return;
        }
        sessionStorage.setItem('chronicle_oidc_redirect_at', String(now));
        authService.clear();
        authService.loginWithOidc();
      };
      window.addEventListener('chronicle:auth-required', onAuthRequired);

      if (config.mode === 'oidc' && !authService.token) {
        onAuthRequired();
        return; // redirecting away; don't render the app
      }

      let user: AuthUser | null = null;
      let reachable = true;
      try {
        user = await authService.me();
      } catch {
        // Preserve the existing offline behavior: the app can still render
        // local recovery/status UI, but collaboration stays disabled without
        // a server-verified user scope.
        reachable = false;
      }
      if (cancelled) return;
      if (user) {
        authService.setUserId(user.id);
        // Reset the loop guard only after the callback token has actually
        // produced a verified server identity.
        sessionStorage.removeItem('chronicle_oidc_redirect_at');
      } else if (config.mode === 'token' && config.requiresToken !== false && reachable) {
        // The server answered and said no: nothing works without the token,
        // so ask for it up front instead of rendering an app that 401s.
        setNeedsToken(true);
        return;
      }
      if (!cancelled) setReady(true);
    })();

    return () => {
      cancelled = true;
      if (onAuthRequired) window.removeEventListener('chronicle:auth-required', onAuthRequired);
    };
  }, []);

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center p-8 text-center text-sm opacity-70">
        {error}
      </div>
    );
  }
  if (needsToken) {
    return (
      <TokenPrompt
        onVerified={(user) => {
          authService.setUserId(user.id);
          setNeedsToken(false);
          setReady(true);
        }}
      />
    );
  }
  if (!ready) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-xs uppercase tracking-[0.2em] opacity-40 animate-pulse">Signing in…</div>
      </div>
    );
  }
  return <>{children}</>;
}

/**
 * The interactive half of AUTH_MODE=token: the server admin generated a single
 * access token (out of band — deploy notes, CREDS file, password manager) and
 * every client presents it. Verified against /api/auth/me before entry.
 */
function TokenPrompt({ onVerified }: { onVerified: (user: AuthUser) => void }) {
  const [value, setValue] = useState('');
  const [checking, setChecking] = useState(false);
  const [promptError, setPromptError] = useState<string | null>(null);

  const submit = async () => {
    const token = value.trim();
    if (!token || checking) return;
    setChecking(true);
    setPromptError(null);
    authService.setToken(token);
    try {
      const user = await authService.me();
      if (user) {
        onVerified(user);
        return;
      }
      authService.clear();
      setPromptError('That token was not accepted. Check it against your deployment’s credentials.');
    } catch {
      setPromptError('Could not reach the server. Check the connection and try again.');
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-manuscript-light dark:bg-manuscript-dark text-black dark:text-[#F1EDE4]">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="w-full max-w-sm rounded-3xl border border-black/10 dark:border-white/10 bg-white dark:bg-[#2b2926] shadow-2xl p-8 space-y-5"
      >
        <div className="flex items-center gap-3">
          <KeyRound className="w-4 h-4 opacity-40" />
          <div>
            <p className="text-[9px] uppercase tracking-[0.2em] font-bold opacity-40">Chronicle</p>
            <h1 className="text-sm font-semibold">Access token required</h1>
          </div>
        </div>
        <p className="text-[11px] leading-relaxed opacity-50">
          This server uses a shared access token. Paste the one from your
          deployment’s credentials; it is remembered on this device.
        </p>
        <input
          type="password"
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Access token"
          aria-label="Access token"
          className="w-full px-4 py-3 rounded-xl border border-black/10 dark:border-white/15 bg-transparent text-sm font-mono focus:outline-none focus:border-blue-500/60"
        />
        {promptError && <p className="text-[11px] text-red-500">{promptError}</p>}
        <button
          type="submit"
          disabled={!value.trim() || checking}
          className="w-full px-4 py-3 rounded-xl bg-black text-white dark:bg-white dark:text-black text-[10px] uppercase font-black tracking-widest disabled:opacity-30 transition-all hover:scale-[1.01] active:scale-95"
        >
          {checking ? 'Checking…' : 'Unlock'}
        </button>
      </form>
    </div>
  );
}
