import { useEffect, useState } from 'react';
import { authService, type AuthConfig } from '../services/authService';

/**
 * Gates the app on authentication. The data services already attach the stored
 * bearer via authFetch; this supplies the missing half — actually obtaining a
 * token in interactive modes.
 *
 * On load it reads /api/auth/config:
 *   - none / forward : no token needed, render immediately.
 *   - token          : render; if requests 401 the user must set a token (out of
 *                      band) — we can't start an interactive flow.
 *   - oidc           : if there's no stored token, redirect into
 *                      /api/auth/oidc/start; the callback stores the token and
 *                      bounces back here. A stored-but-expired token is caught by
 *                      the global 'chronicle:auth-required' (401) handler, which
 *                      clears it and re-logs-in — guarded against redirect loops.
 */
export function AuthGate({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let onAuthRequired: (() => void) | null = null;

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

      // On a 401 in OIDC mode, drop the dead token and restart login. The
      // timestamp guard stops an invalid-session redirect loop.
      onAuthRequired = () => {
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

      // We have (or don't need) a token — reset the loop guard so a future
      // session expiry can restart login.
      sessionStorage.removeItem('chronicle_oidc_redirect_at');
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
  if (!ready) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-xs uppercase tracking-[0.2em] opacity-40 animate-pulse">Signing in…</div>
      </div>
    );
  }
  return <>{children}</>;
}
