import 'dotenv/config';
import path from 'path';

/**
 * Server config, sourced entirely from env. Container-first.
 *
 * Four auth modes:
 *   - 'none'    : no auth, single shared local user. Trusted networks only.
 *   - 'token'   : static bearer token. Easiest lock-down for personal use.
 *   - 'forward' : trust headers from an upstream proxy (Authelia/Authentik/
 *                 Caddy/Traefik forward-auth). Proxy IP verified against
 *                 AUTH_FORWARD_TRUSTED_PROXIES.
 *   - 'oidc'    : full OIDC with discovery. Works with Keycloak, Authentik,
 *                 Authelia (via its OIDC provider), Auth0, Google, etc.
 */
type AuthMode = 'none' | 'token' | 'forward' | 'oidc';

const rawMode = (process.env.AUTH_MODE || 'none').toLowerCase();
const authMode: AuthMode = (
  rawMode === 'token' || rawMode === 'forward' || rawMode === 'oidc'
    ? rawMode
    : 'none'
) as AuthMode;

export const config = {
  port: parseInt(process.env.PORT || '80', 10),
  host: process.env.HOST || '0.0.0.0',
  dataDir: process.env.DATA_DIR || path.join(process.cwd(), 'data'),
  isProd: process.env.NODE_ENV === 'production',

  sessionTtlMs: 1000 * 60 * 60 * 24 * 30,
  tombstoneRetentionMs: 1000 * 60 * 60 * 24 * 30,

  auth: {
    mode: authMode,

    // --- token mode ---
    token: process.env.AUTH_TOKEN || '',

    // --- forward mode ---
    forward: {
      headerUser: process.env.AUTH_FORWARD_HEADER_USER || 'Remote-User',
      headerEmail: process.env.AUTH_FORWARD_HEADER_EMAIL || 'Remote-Email',
      headerName: process.env.AUTH_FORWARD_HEADER_NAME || 'Remote-Name',
      headerGroups: process.env.AUTH_FORWARD_HEADER_GROUPS || 'Remote-Groups',
      // Comma-separated. Accepts CIDR plus the named presets
      // 'loopback', 'linklocal', 'uniquelocal' (RFC1918 + ULA). Defaults
      // cover typical Docker / reverse-proxy setups; tighten in production.
      trustedProxies:
        process.env.AUTH_FORWARD_TRUSTED_PROXIES ||
        'loopback,linklocal,uniquelocal',
      // Optional extra defense: a shared secret the proxy must set.
      sharedSecretHeader: process.env.AUTH_FORWARD_SECRET_HEADER || '',
      sharedSecret: process.env.AUTH_FORWARD_SECRET || '',
      // Optional admin group (matched in headerGroups, comma-separated).
      adminGroup: process.env.AUTH_FORWARD_ADMIN_GROUP || '',
    },

    // --- oidc mode ---
    oidc: {
      issuerUrl: process.env.AUTH_OIDC_ISSUER_URL || '',
      clientId: process.env.AUTH_OIDC_CLIENT_ID || '',
      clientSecret: process.env.AUTH_OIDC_CLIENT_SECRET || '',
      redirectUri: process.env.AUTH_OIDC_REDIRECT_URI || '',
      scopes: process.env.AUTH_OIDC_SCOPES || 'openid profile email',
      // Optional post-logout redirect for RP-initiated logout.
      postLogoutRedirectUri: process.env.AUTH_OIDC_POST_LOGOUT_REDIRECT_URI || '',
      // 'auto' picks none for public clients, basic for confidential.
      tokenEndpointAuthMethod:
        process.env.AUTH_OIDC_TOKEN_AUTH_METHOD || 'auto',
    },
  },

  nextcloud: {
    /** Standalone Nextcloud OAuth flow, kept for WebDAV mirror token capture. */
    enabled: !!process.env.NEXTCLOUD_URL,
    url: (process.env.NEXTCLOUD_URL || '').replace(/\/$/, ''),
    clientId: process.env.NEXTCLOUD_CLIENT_ID || '',
    clientSecret: process.env.NEXTCLOUD_CLIENT_SECRET || '',
    redirectUri: process.env.NEXTCLOUD_REDIRECT_URI || '',
    mirrorEnabled: process.env.NEXTCLOUD_MIRROR === 'true',
    mirrorRoot: process.env.NEXTCLOUD_MIRROR_ROOT || 'Chronicle',

    /** Backend App Password auth (S3-style connector) */
    user: process.env.NC_USER || '',
    pass: process.env.NC_PASS || '',
    storageDir: process.env.NC_DIR || 'Chronicle_Storage',
  },

  storageProvider: (process.env.STORAGE_PROVIDER || 'sqlite').toLowerCase() as 'sqlite' | 'hybrid',

  /**
   * AI keys. Held server-side so the browser never sees them. The client
   * picks a provider/model from the UI; the server attaches the matching
   * key and forwards. Set neither and AI features show as unavailable.
   */
  openaiKey: process.env.OPENAI_API_KEY || '',
  anthropicKey: process.env.ANTHROPIC_API_KEY || '',
  geminiKey: process.env.GEMINI_API_KEY || '',
  /** Default model when the client doesn't specify one. */
  aiModel: process.env.AI_MODEL || 'gpt-4o',
  /** OpenAI TTS model + voice for /api/ai/speak. */
  audioModel: process.env.AUDIO_MODEL || 'gpt-4o-mini-tts',
  audioVoice: process.env.AUDIO_VOICE || 'alloy',
};

export type AppConfig = typeof config;

/** Validate config at boot; throws with a helpful message on misconfiguration. */
export function validateConfig(): void {
  const a = config.auth;
  if (a.mode === 'token' && !a.token) {
    throw new Error('AUTH_MODE=token requires AUTH_TOKEN to be set.');
  }
  if (a.mode === 'oidc') {
    const missing: string[] = [];
    if (!a.oidc.issuerUrl) missing.push('AUTH_OIDC_ISSUER_URL');
    if (!a.oidc.clientId) missing.push('AUTH_OIDC_CLIENT_ID');
    if (!a.oidc.redirectUri) missing.push('AUTH_OIDC_REDIRECT_URI');
    if (missing.length) {
      throw new Error(`AUTH_MODE=oidc requires: ${missing.join(', ')}`);
    }
  }
  if (a.mode === 'forward') {
    if (!a.forward.trustedProxies) {
      throw new Error(
        'AUTH_MODE=forward requires AUTH_FORWARD_TRUSTED_PROXIES (or leave unset for the safe default).',
      );
    }
  }

  if (config.storageProvider === 'hybrid') {
    const n = config.nextcloud;
    if (!n.url || !n.user || !n.pass) {
      throw new Error(
        'STORAGE_PROVIDER=hybrid requires NEXTCLOUD_URL, NC_USER, and NC_PASS (App Password) to be set.',
      );
    }
  }
}
