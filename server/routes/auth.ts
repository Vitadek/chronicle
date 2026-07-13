import { Router } from 'express';
import crypto from 'crypto';
import type { Request, Response } from 'express';
import { db } from '../db';
import { config } from '../config';
import { authMiddleware, createSession, revokeSession, upsertExternalUser } from '../auth';
import { getOidcClient, extractUser, generators } from '../oidc';

const router = Router();

// ----------------------------------------------------------------------------
// Public config — lets the client know what auth flow to use.
// Safe to expose: contains no secrets, just the mode and login URL.
// ----------------------------------------------------------------------------
router.get('/config', (_req, res) => {
  const mode = config.auth.mode;
  const out: Record<string, unknown> = {
    mode,
    // True when the server has at least one provider key configured. The
    // UI uses this to gate the AI toggle.
    aiAvailable: !!(config.openaiKey || config.anthropicKey || config.geminiKey),
    aiProviders: {
      openai: !!config.openaiKey,
      anthropic: !!config.anthropicKey,
      gemini: !!config.geminiKey,
    },
  };

  if (mode === 'oidc') {
    out.loginUrl = '/api/auth/oidc/start';
    out.logoutUrl = '/api/auth/logout';
  } else if (mode === 'token') {
    out.requiresToken = true;
  }
  if (config.nextcloud.enabled) {
    out.nextcloudConnectUrl = '/api/auth/nextcloud/start';
  }
  res.json(out);
});

// ----------------------------------------------------------------------------
// Generic OIDC: Keycloak, Authentik, Authelia, Auth0, Google, ...
// ----------------------------------------------------------------------------

router.get('/oidc/start', async (_req, res) => {
  if (config.auth.mode !== 'oidc') {
    res.status(404).json({ error: 'OIDC not enabled' });
    return;
  }
  try {
    const client = await getOidcClient();
    const codeVerifier = generators.codeVerifier();
    const codeChallenge = generators.codeChallenge(codeVerifier);
    const state = generators.state();
    const nonce = generators.nonce();

    db.prepare(
      'INSERT INTO kv (k, v, expires_at) VALUES (?, ?, ?)',
    ).run(
      `oidc:${state}`,
      JSON.stringify({ codeVerifier, nonce }),
      Date.now() + 10 * 60 * 1000,
    );

    const url = client.authorizationUrl({
      scope: config.auth.oidc.scopes,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state,
      nonce,
    });
    res.redirect(url);
  } catch (err) {
    console.error('[auth/oidc] start failed:', err);
    res.status(502).send('OIDC provider unreachable. Try again in a moment.');
  }
});

router.get('/oidc/callback', async (req: Request, res: Response) => {
  if (config.auth.mode !== 'oidc') {
    res.status(404).json({ error: 'OIDC not enabled' });
    return;
  }
  const state = req.query.state;
  if (typeof state !== 'string' || !state) {
    res.status(400).send('Missing state');
    return;
  }

  const row = db
    .prepare('SELECT v, expires_at FROM kv WHERE k = ?')
    .get(`oidc:${state}`) as { v: string; expires_at: number } | undefined;
  if (!row || row.expires_at < Date.now()) {
    res.status(400).send('Invalid or expired state');
    return;
  }
  db.prepare('DELETE FROM kv WHERE k = ?').run(`oidc:${state}`);
  const { codeVerifier, nonce } = JSON.parse(row.v) as {
    codeVerifier: string;
    nonce: string;
  };

  try {
    const client = await getOidcClient();
    const params = client.callbackParams(req);
    const tokens = await client.callback(
      config.auth.oidc.redirectUri,
      params,
      { code_verifier: codeVerifier, state, nonce },
    );

    const user = await extractUser(client, tokens);
    const userId = upsertExternalUser({
      provider: 'oidc',
      issuer: config.auth.oidc.issuerUrl,
      externalId: user.sub,
      email: user.email,
      displayName: user.displayName,
    });
    const token = createSession(userId);

    res.redirect(`/auth/complete#token=${encodeURIComponent(token)}`);
  } catch (err) {
    console.error('[auth/oidc] callback failed:', err);
    res.status(502).send('OIDC token exchange failed');
  }
});

// ----------------------------------------------------------------------------
// Nextcloud OAuth identity (optional)
//
// In oidc mode this can link a Nextcloud identity; in none/token modes it can
// serve as the primary login. Storage replication uses one server-side target
// selected by STORAGE_REPLICA and is deliberately independent of this flow.
// ----------------------------------------------------------------------------

router.get('/nextcloud/start', (_req, res) => {
  if (!config.nextcloud.enabled) {
    res.status(404).json({ error: 'Nextcloud not configured' });
    return;
  }
  const state = crypto.randomBytes(24).toString('base64url');
  db.prepare(
    'INSERT INTO kv (k, v, expires_at) VALUES (?, ?, ?)',
  ).run(`ncoauth:${state}`, '1', Date.now() + 10 * 60 * 1000);

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.nextcloud.clientId,
    redirect_uri: config.nextcloud.redirectUri,
    state,
  });
  res.redirect(
    `${config.nextcloud.url}/index.php/apps/oauth2/authorize?${params.toString()}`,
  );
});

router.get('/nextcloud/callback', async (req, res) => {
  if (!config.nextcloud.enabled) {
    res.status(404).json({ error: 'Nextcloud not configured' });
    return;
  }
  const { code, state } = req.query as { code?: string; state?: string };
  if (!code || !state) {
    res.status(400).send('Missing code or state');
    return;
  }
  const stateRow = db
    .prepare('SELECT k FROM kv WHERE k = ? AND (expires_at IS NULL OR expires_at > ?)')
    .get(`ncoauth:${state}`, Date.now());
  if (!stateRow) {
    res.status(400).send('Invalid or expired state');
    return;
  }
  db.prepare('DELETE FROM kv WHERE k = ?').run(`ncoauth:${state}`);

  let tokens: {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    user_id: string;
  };
  try {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: config.nextcloud.redirectUri,
      client_id: config.nextcloud.clientId,
      client_secret: config.nextcloud.clientSecret,
    });
    const tokenRes = await fetch(
      `${config.nextcloud.url}/index.php/apps/oauth2/api/v1/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      },
    );
    if (!tokenRes.ok) {
      res.status(502).send('Nextcloud token exchange failed');
      return;
    }
    tokens = await tokenRes.json();
  } catch {
    res.status(502).send('Failed to reach Nextcloud');
    return;
  }

  let displayName = tokens.user_id;
  let email: string | null = null;
  try {
    const u = await fetch(
      `${config.nextcloud.url}/ocs/v2.php/cloud/user?format=json`,
      {
        headers: {
          Authorization: `Bearer ${tokens.access_token}`,
          'OCS-APIRequest': 'true',
        },
      },
    );
    if (u.ok) {
      const j = (await u.json()) as any;
      displayName = j?.ocs?.data?.displayname || displayName;
      email = j?.ocs?.data?.email || null;
    }
  } catch {
    /* non-fatal */
  }

  // Reuse the generic external-user path with provider='nextcloud' so
  // the same NC account always resolves to the same local user even if
  // they also log in via generic OIDC pointed at the same NC instance.
  const existing = db
    .prepare(
      `SELECT id FROM users WHERE nc_url = ? AND nc_user_id = ?`,
    )
    .get(config.nextcloud.url, tokens.user_id) as { id: string } | undefined;

  let userId: string;
  if (existing) {
    userId = existing.id;
    db.prepare(
      `UPDATE users SET display_name = ?, email = COALESCE(?, email) WHERE id = ?`,
    ).run(displayName, email, userId);
  } else {
    userId = crypto.randomBytes(12).toString('base64url');
    db.prepare(
      `INSERT INTO users
         (id, email, display_name, nc_user_id, nc_url, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(userId, email, displayName, tokens.user_id, config.nextcloud.url, Date.now());
  }

  const sessionToken = createSession(userId, {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresInSec: tokens.expires_in,
  });
  res.redirect(`/auth/complete#token=${encodeURIComponent(sessionToken)}`);
});

// ----------------------------------------------------------------------------
// Authenticated info + logout
// (These run after the main auth middleware via the router-level guard.)
// ----------------------------------------------------------------------------

router.get('/me', authMiddleware, (req, res) => {
  if (!req.userId) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }
  const user = db
    .prepare(
      `SELECT id, email, display_name, external_provider, external_issuer,
              nc_user_id, nc_url
         FROM users WHERE id = ?`,
    )
    .get(req.userId) as Record<string, unknown> | undefined;
  res.json({ ...(user || { id: req.userId }), authVia: req.authVia });
});

router.post('/logout', authMiddleware, (req, res) => {
  if (req.sessionToken) revokeSession(req.sessionToken);

  // RP-initiated logout for OIDC if configured.
  if (
    config.auth.mode === 'oidc' &&
    config.auth.oidc.postLogoutRedirectUri
  ) {
    getOidcClient()
      .then((client) => {
        try {
          const url = client.endSessionUrl({
            post_logout_redirect_uri: config.auth.oidc.postLogoutRedirectUri,
          });
          res.json({ ok: true, postLogoutUrl: url });
        } catch {
          // Issuer doesn't advertise end_session_endpoint.
          res.json({ ok: true });
        }
      })
      .catch(() => res.json({ ok: true }));
    return;
  }
  res.json({ ok: true });
});

export default router;
