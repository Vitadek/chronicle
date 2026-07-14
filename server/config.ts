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
export type StorageReplica = 'none' | 'nextcloud' | 's3';

const rawMode = (process.env.AUTH_MODE || 'none').toLowerCase();
const authMode: AuthMode = (
  rawMode === 'token' || rawMode === 'forward' || rawMode === 'oidc'
    ? rawMode
    : 'none'
) as AuthMode;

const legacyStorageProvider = (process.env.STORAGE_PROVIDER || '').trim().toLowerCase();
const configuredStorageReplica = (process.env.STORAGE_REPLICA || '').trim().toLowerCase();
const rawStorageReplica = configuredStorageReplica || (
  !legacyStorageProvider || legacyStorageProvider === 'sqlite'
    ? 'none'
    : legacyStorageProvider === 'hybrid'
      ? 'nextcloud'
      : legacyStorageProvider
);

function envBoolean(name: string, fallback = false): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw.toLowerCase() === 'true';
}

function envPositiveInt(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  host: process.env.HOST || '0.0.0.0',
  dataDir: process.env.DATA_DIR || path.join(process.cwd(), 'data'),
  isProd: process.env.NODE_ENV === 'production',

  // Single-user "local admin" surface: whole-database backup/restore over HTTP
  // (the .chron export/import). Unreasonable on a shared multi-user server — one
  // user could dump or overwrite everyone's data — so it is OFF by default and
  // only turned on by the single-user desktop build. See server/routes/backup.ts.
  localAdmin: envBoolean('LOCAL_ADMIN'),

  sessionTtlMs: 1000 * 60 * 60 * 24 * 30,

  auth: {
    mode: authMode,
    allowInsecureNoAuth: envBoolean('ALLOW_INSECURE_NO_AUTH'),

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
    /** Standalone Nextcloud OAuth identity flow. */
    enabled: !!process.env.NEXTCLOUD_URL,
    url: (process.env.NEXTCLOUD_URL || '').replace(/\/$/, ''),
    allowInsecureHttp: envBoolean('NEXTCLOUD_ALLOW_INSECURE_HTTP'),
    clientId: process.env.NEXTCLOUD_CLIENT_ID || '',
    clientSecret: process.env.NEXTCLOUD_CLIENT_SECRET || '',
    redirectUri: process.env.NEXTCLOUD_REDIRECT_URI || '',
    /** @deprecated The second write path was replaced by STORAGE_REPLICA. */
    mirrorEnabled: envBoolean('NEXTCLOUD_MIRROR'),
    /** @deprecated The legacy OAuth mirror root is no longer used. */
    legacyMirrorRoot: (process.env.NEXTCLOUD_MIRROR_ROOT || '').trim(),

    /** Backend App Password auth (S3-style connector) */
    user: process.env.NC_USER || '',
    pass: process.env.NC_PASS || '',
    storageDir: process.env.NC_DIR || 'Chronicle_Storage',
  },

  storage: {
    replica: rawStorageReplica as StorageReplica,
    /** Set when the deprecated STORAGE_PROVIDER compatibility mapping is in use. */
    legacyProvider: configuredStorageReplica ? '' : legacyStorageProvider,
    retryIntervalMs: envPositiveInt('STORAGE_RETRY_INTERVAL_MS', 30_000),
    maxAttempts: envPositiveInt('STORAGE_MAX_ATTEMPTS', 10),
  },

  s3: {
    bucket: process.env.S3_BUCKET || '',
    region: process.env.S3_REGION || 'us-east-1',
    endpoint: (process.env.S3_ENDPOINT || '').replace(/\/+$/, ''),
    prefix: (process.env.S3_PREFIX || 'chronicle').replace(/^\/+|\/+$/g, ''),
    forcePathStyle: envBoolean('S3_FORCE_PATH_STYLE'),
    allowInsecureHttp: envBoolean('S3_ALLOW_INSECURE_HTTP'),
    serverSideEncryption: process.env.S3_SERVER_SIDE_ENCRYPTION || '',
    kmsKeyId: process.env.S3_KMS_KEY_ID || '',
  },

  /** @deprecated Use config.storage.replica. Kept for existing route compatibility. */
  storageProvider: (rawStorageReplica === 'none' ? 'sqlite' : 'hybrid') as 'sqlite' | 'hybrid',

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
  /**
   * AI_UI=off removes every AI surface from the client (settings panels,
   * toggles, slash commands, bubble menu) and makes the server refuse AI
   * API calls — for deployments that want a purely manual writing tool.
   * Default on; any of off/false/0/no disables (people reach for all four).
   */
  aiUiEnabled: !['off', 'false', '0', 'no'].includes((process.env.AI_UI || 'on').toLowerCase()),
  /** OpenAI TTS model + voice for /api/ai/speak. */
  audioModel: process.env.AUDIO_MODEL || 'gpt-4o-mini-tts',
  audioVoice: process.env.AUDIO_VOICE || 'alloy',

  grammar: {
    /**
     * The LanguageTool sidecar. Note the DEFAULT: this is always a non-empty
     * string, so "is LanguageTool available?" cannot be answered by checking
     * whether it is set — plugin capability detection probes it instead
     * (server/lib/pluginCapabilities.ts).
     */
    languagetoolUrl: (process.env.LANGUAGETOOL_URL || 'http://languagetool:8010').replace(/\/+$/, ''),
    languagetoolLang: process.env.LANGUAGETOOL_LANG || 'en-US',
  },
};

export type AppConfig = typeof config;

/** Validate config at boot; non-listening CLI commands may skip bind-only checks. */
export function validateConfig(options: { listening?: boolean } = {}): void {
  const a = config.auth;
  if (!['none', 'token', 'forward', 'oidc'].includes(rawMode)) {
    throw new Error(
      `Invalid AUTH_MODE="${rawMode}". Expected none, token, forward, or oidc.`,
    );
  }
  const loopbackHosts = new Set(['127.0.0.1', '::1', '[::1]', 'localhost']);
  if (
    config.isProd &&
    options.listening !== false &&
    a.mode === 'none' &&
    !loopbackHosts.has(config.host.toLowerCase()) &&
    !a.allowInsecureNoAuth
  ) {
    throw new Error(
      'Production AUTH_MODE=none may only bind to loopback. ' +
      'For an explicitly trusted network, set ALLOW_INSECURE_NO_AUTH=true.',
    );
  }
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

  if (!['none', 'nextcloud', 's3'].includes(config.storage.replica)) {
    throw new Error(
      `Invalid STORAGE_REPLICA="${config.storage.replica}". Expected none, nextcloud, or s3.`,
    );
  }

  if (config.nextcloud.mirrorEnabled || config.nextcloud.legacyMirrorRoot) {
    throw new Error(
      'NEXTCLOUD_MIRROR and NEXTCLOUD_MIRROR_ROOT are retired because Chronicle ' +
      'supports exactly one durable remote. Remove both legacy settings and ' +
      'use STORAGE_REPLICA=nextcloud with NC_USER and NC_PASS instead.',
    );
  }

  if (config.nextcloud.url) {
    let endpoint: URL;
    try {
      endpoint = new URL(config.nextcloud.url);
    } catch {
      throw new Error('NEXTCLOUD_URL must be a valid absolute URL.');
    }
    if (endpoint.protocol !== 'https:' && endpoint.protocol !== 'http:') {
      throw new Error('NEXTCLOUD_URL must use http or https.');
    }
    if (endpoint.protocol !== 'https:' && !config.nextcloud.allowInsecureHttp) {
      throw new Error(
        'NEXTCLOUD_URL must use HTTPS. For a trusted LAN only, explicitly set ' +
        'NEXTCLOUD_ALLOW_INSECURE_HTTP=true.',
      );
    }
  }

  if (config.storage.legacyProvider) {
    if (!['sqlite', 'hybrid'].includes(config.storage.legacyProvider)) {
      throw new Error(
        `Invalid STORAGE_PROVIDER="${config.storage.legacyProvider}". ` +
        'Use STORAGE_REPLICA=none|nextcloud|s3.',
      );
    }
    console.warn(
      `[config] STORAGE_PROVIDER=${config.storage.legacyProvider} is deprecated; ` +
      `use STORAGE_REPLICA=${config.storage.replica}.`,
    );
  }

  if (config.storage.replica === 'nextcloud') {
    const n = config.nextcloud;
    if (!n.url || !n.user || !n.pass) {
      throw new Error(
        'STORAGE_REPLICA=nextcloud requires NEXTCLOUD_URL, NC_USER, and NC_PASS (App Password).',
      );
    }
  }

  if (config.storage.replica === 's3') {
    if (!config.s3.bucket) {
      throw new Error('STORAGE_REPLICA=s3 requires S3_BUCKET.');
    }
    if (config.s3.endpoint) {
      let endpoint: URL;
      try {
        endpoint = new URL(config.s3.endpoint);
      } catch {
        throw new Error('S3_ENDPOINT must be a valid absolute URL.');
      }
      if (endpoint.protocol !== 'https:' && !config.s3.allowInsecureHttp) {
        throw new Error(
          'S3_ENDPOINT must use HTTPS. For a trusted LAN only, explicitly set S3_ALLOW_INSECURE_HTTP=true.',
        );
      }
      if (endpoint.protocol !== 'https:' && endpoint.protocol !== 'http:') {
        throw new Error('S3_ENDPOINT must use http or https.');
      }
    }
    if (!['', 'AES256', 'aws:kms'].includes(config.s3.serverSideEncryption)) {
      throw new Error('S3_SERVER_SIDE_ENCRYPTION must be empty, AES256, or aws:kms.');
    }
    if (config.s3.serverSideEncryption === 'aws:kms' && !config.s3.kmsKeyId) {
      throw new Error('S3_SERVER_SIDE_ENCRYPTION=aws:kms requires S3_KMS_KEY_ID.');
    }
  }
}
