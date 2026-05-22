/**
 * Token storage + authenticated fetch + login flow helpers.
 *
 * Server can be in one of four modes (see server/config.ts):
 *   - 'none'    : no token needed, every request just works
 *   - 'token'   : a static bearer token, set out of band
 *   - 'forward' : proxy injects identity headers, no token needed
 *   - 'oidc'    : login via /api/auth/oidc/start, token stashed in localStorage
 *
 * authFetch sends the stored token if present and the server ignores it
 * when not relevant. The client doesn't need to know the mode in advance.
 */

const TOKEN_KEY = 'chronicle_token';

export interface AuthConfig {
  mode: 'none' | 'token' | 'forward' | 'oidc';
  loginUrl?: string;
  logoutUrl?: string;
  requiresToken?: boolean;
  nextcloudConnectUrl?: string;
  /** Whether the server has an OPENAI_API_KEY set. */
  aiAvailable?: boolean;
}

export const authService = {
  get token(): string | null {
    return localStorage.getItem(TOKEN_KEY);
  },

  setToken(t: string): void {
    localStorage.setItem(TOKEN_KEY, t);
  },

  clear(): void {
    localStorage.removeItem(TOKEN_KEY);
  },

  /** Read public auth config from the server. Safe to call without a token. */
  async getConfig(): Promise<AuthConfig> {
    const res = await fetch('/api/auth/config');
    if (!res.ok) throw new Error('Failed to fetch auth config');
    return res.json();
  },

  /** Begin generic OIDC login (Keycloak, Authentik, Authelia, ...). */
  loginWithOidc(): void {
    window.location.href = '/api/auth/oidc/start';
  },

  /**
   * Begin Nextcloud OAuth flow. Primary purpose is to capture the WebDAV
   * access token so the mirror feature works. In none/token modes it can
   * also serve as the primary login.
   */
  loginWithNextcloud(): void {
    window.location.href = '/api/auth/nextcloud/start';
  },

  async me(): Promise<unknown | null> {
    const res = await authFetch('/api/auth/me');
    if (!res.ok) return null;
    return res.json();
  },

  async logout(): Promise<void> {
    let postLogoutUrl: string | undefined;
    try {
      const res = await authFetch('/api/auth/logout', { method: 'POST' });
      if (res.ok) {
        const body = (await res.json()) as { postLogoutUrl?: string };
        postLogoutUrl = body?.postLogoutUrl;
      }
    } finally {
      this.clear();
    }
    if (postLogoutUrl) window.location.href = postLogoutUrl;
  },
};

/**
 * Like fetch(), but with a bearer token attached when present. Dispatches
 * 'chronicle:auth-required' on 401 so the UI can show a login button.
 */
export async function authFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  const token = authService.token;
  const headers = new Headers(init.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const res = await fetch(input, { ...init, headers });
  if (res.status === 401) {
    window.dispatchEvent(new CustomEvent('chronicle:auth-required'));
  }
  return res;
}
